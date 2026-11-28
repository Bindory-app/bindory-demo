-- 017: server-managed WhatsApp channel state. Apply after 016. No media bytes or chat transcript here.
BEGIN;
CREATE TABLE IF NOT EXISTS public.whatsapp_links (
 user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
 phone text UNIQUE CHECK (phone ~ '^[1-9][0-9]{5,14}$'),
 bsuid text UNIQUE CHECK (bsuid ~ '^[A-Z]{2}\.[a-zA-Z0-9]{1,128}$'),
 channel_id uuid UNIQUE NOT NULL DEFAULT gen_random_uuid(),
 country text NOT NULL DEFAULT 'US',
 link_nonce uuid UNIQUE, link_expires timestamptz,
 chat_since timestamptz NOT NULL DEFAULT now(), last_inbound timestamptz, last_reminder timestamptz,
 held_media text, held_caption text, held_at timestamptz,
 step jsonb NOT NULL DEFAULT '{}'
);
ALTER TABLE public.whatsapp_links ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.whatsapp_links FROM PUBLIC, anon, authenticated;
GRANT SELECT, DELETE ON public.whatsapp_links TO authenticated;
DROP POLICY IF EXISTS whatsapp_read_own ON public.whatsapp_links;
DROP POLICY IF EXISTS whatsapp_unlink_own ON public.whatsapp_links;
CREATE POLICY whatsapp_read_own ON public.whatsapp_links FOR SELECT TO authenticated USING (user_id=auth.uid());
CREATE POLICY whatsapp_unlink_own ON public.whatsapp_links FOR DELETE TO authenticated USING (user_id=auth.uid());
GRANT ALL ON public.whatsapp_links TO service_role;

-- No phone, token, media or message body in the retry ledger.
CREATE TABLE IF NOT EXISTS public.whatsapp_receipts (id text PRIMARY KEY, received_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS whatsapp_receipts_age ON public.whatsapp_receipts(received_at);
ALTER TABLE public.whatsapp_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.whatsapp_receipts FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.whatsapp_receipts TO service_role;

-- A challenge is unique, expires, and cannot move an existing phone to another collector.
CREATE OR REPLACE FUNCTION public.bind_whatsapp(p_nonce uuid,p_phone text,p_bsuid text,p_at timestamptz) RETURNS boolean
LANGUAGE plpgsql SECURITY INVOKER SET search_path=public AS $$
BEGIN
 -- A fresh signed-in handoff may replace this collector's old sender. Never
 -- retain a missing alias from a different sender, an old checkout, or a pending photo.
 UPDATE public.whatsapp_links SET channel_id=gen_random_uuid(), chat_since=now(),
   phone=coalesce(p_phone,CASE WHEN bsuid=p_bsuid THEN phone END),
   bsuid=coalesce(p_bsuid,CASE WHEN phone=p_phone THEN bsuid END),
   step='{}',held_media=NULL,held_caption=NULL,held_at=NULL,link_nonce=NULL,link_expires=NULL,
   last_inbound=least(p_at,now())
 WHERE link_nonce=p_nonce AND link_expires>now() AND (p_phone IS NOT NULL OR p_bsuid IS NOT NULL);
 RETURN FOUND;
EXCEPTION WHEN unique_violation THEN RETURN false;
END; $$;

-- A row lock, not a JS read-then-write, decides which delivery completes a pair.
CREATE OR REPLACE FUNCTION public.pair_whatsapp_photo(p_user uuid,p_channel uuid,p_media text,p_caption text)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=public AS $$
DECLARE l public.whatsapp_links%ROWTYPE;
BEGIN
 SELECT * INTO STRICT l FROM public.whatsapp_links WHERE user_id=p_user AND channel_id=p_channel FOR UPDATE;
 IF l.held_media IS NULL OR l.held_at <= now()-interval '30 minutes' THEN
  UPDATE public.whatsapp_links SET held_media=p_media,held_caption=p_caption,held_at=now() WHERE user_id=p_user;
  RETURN NULL;
 END IF;
 UPDATE public.whatsapp_links SET held_media=NULL,held_caption=NULL,held_at=NULL WHERE user_id=p_user;
 RETURN jsonb_build_object('media',jsonb_build_array(l.held_media,p_media),'caption',concat_ws(' ',nullif(l.held_caption,''),nullif(p_caption,'')));
END; $$;

CREATE OR REPLACE FUNCTION public.touch_whatsapp(p_phone text,p_bsuid text,p_at timestamptz) RETURNS SETOF public.whatsapp_links
LANGUAGE sql SECURITY INVOKER SET search_path=public AS $$
 UPDATE public.whatsapp_links SET phone=coalesce(phone,p_phone),bsuid=coalesce(bsuid,p_bsuid),last_inbound=greatest(last_inbound,least(p_at,now()))
 WHERE (phone=p_phone OR bsuid=p_bsuid)
 AND (phone IS NULL OR p_phone IS NULL OR phone=p_phone) AND (bsuid IS NULL OR p_bsuid IS NULL OR bsuid=p_bsuid)
 AND NOT EXISTS (SELECT 1 FROM public.whatsapp_links other WHERE other.user_id<>whatsapp_links.user_id AND (other.phone=p_phone OR other.bsuid=p_bsuid))
 RETURNING *;
$$;

-- Inbound and scheduled reminders must compete for the same daily slot. Recheck eligibility here.
GRANT SELECT ON public.market_orders TO service_role;
CREATE OR REPLACE FUNCTION public.claim_whatsapp_reminder(p_user uuid,p_channel uuid,p_template boolean)
RETURNS SETOF public.whatsapp_links LANGUAGE sql SECURITY INVOKER SET search_path=public AS $$
 UPDATE public.whatsapp_links l SET last_reminder=now()
 WHERE l.user_id=p_user AND l.channel_id=p_channel AND (l.phone IS NOT NULL OR l.bsuid IS NOT NULL)
 AND (l.last_reminder IS NULL OR l.last_reminder<=now()-interval '24 hours')
 AND (p_template OR l.last_inbound>now()-interval '24 hours')
 AND EXISTS (SELECT 1 FROM public.market_orders o WHERE o.user_id=l.user_id AND o.status='pending' AND o.expires_at>now())
 RETURNING l.*;
$$;
REVOKE ALL ON FUNCTION public.bind_whatsapp(uuid,text,text,timestamptz),public.pair_whatsapp_photo(uuid,uuid,text,text),public.touch_whatsapp(text,text,timestamptz),public.claim_whatsapp_reminder(uuid,uuid,boolean) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.bind_whatsapp(uuid,text,text,timestamptz),public.pair_whatsapp_photo(uuid,uuid,text,text),public.touch_whatsapp(text,text,timestamptz),public.claim_whatsapp_reminder(uuid,uuid,boolean) TO service_role;
COMMIT;
