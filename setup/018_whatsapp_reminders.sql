-- 018: service-only candidate enumeration. The existing atomic claim in 017 is authoritative.
BEGIN;
GRANT SELECT ON public.market_orders TO service_role;
CREATE INDEX IF NOT EXISTS market_orders_pending_owner_expiry ON public.market_orders(user_id,expires_at) WHERE status='pending';
-- STOP deletes the channel row. Keep only the collector's slot, not a sender id,
-- so unlinking/relinking cannot reset the rolling limit. Account deletion removes it.
CREATE TABLE IF NOT EXISTS public.whatsapp_reminder_slots (
 user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
 reminded_at timestamptz NOT NULL
);
ALTER TABLE public.whatsapp_reminder_slots ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.whatsapp_reminder_slots FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE ON public.whatsapp_reminder_slots TO service_role;
INSERT INTO public.whatsapp_reminder_slots AS s(user_id,reminded_at)
 SELECT user_id,last_reminder FROM public.whatsapp_links WHERE last_reminder>now()-interval '24 hours'
 ON CONFLICT(user_id) DO UPDATE SET reminded_at=greatest(s.reminded_at,EXCLUDED.reminded_at);

-- Reserve the per-collector slot inside 017's atomic claim. A suppressed update
-- returns zero rows to both the webhook and cron even if they race on different links.
CREATE OR REPLACE FUNCTION public.reserve_whatsapp_reminder_slot() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=public AS $$
BEGIN
 INSERT INTO public.whatsapp_reminder_slots AS s(user_id,reminded_at) VALUES(NEW.user_id,NEW.last_reminder)
 ON CONFLICT(user_id) DO UPDATE SET reminded_at=EXCLUDED.reminded_at
 WHERE s.reminded_at<=EXCLUDED.reminded_at-interval '24 hours';
 IF NOT FOUND THEN RETURN NULL; END IF;
 RETURN NEW;
END; $$;
REVOKE ALL ON FUNCTION public.reserve_whatsapp_reminder_slot() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_whatsapp_reminder_slot() TO service_role;
DROP TRIGGER IF EXISTS whatsapp_reminder_slot ON public.whatsapp_links;
CREATE TRIGGER whatsapp_reminder_slot BEFORE UPDATE OF last_reminder ON public.whatsapp_links
 FOR EACH ROW WHEN (NEW.last_reminder IS NOT NULL AND NEW.last_reminder IS DISTINCT FROM OLD.last_reminder)
 EXECUTE FUNCTION public.reserve_whatsapp_reminder_slot();

CREATE OR REPLACE FUNCTION public.whatsapp_reminder_candidates(p_after uuid,p_template boolean,p_limit integer)
RETURNS TABLE(user_id uuid,channel_id uuid) LANGUAGE sql STABLE SECURITY INVOKER SET search_path=public AS $$
 SELECT l.user_id,l.channel_id FROM public.whatsapp_links l
 WHERE (p_after IS NULL OR l.user_id>p_after) AND (l.phone IS NOT NULL OR l.bsuid IS NOT NULL)
 AND (l.last_reminder IS NULL OR l.last_reminder<=now()-interval '24 hours')
 AND NOT EXISTS (SELECT 1 FROM public.whatsapp_reminder_slots s WHERE s.user_id=l.user_id AND s.reminded_at>now()-interval '24 hours')
 AND (p_template OR public.whatsapp_freeform_until(l.last_inbound)>now())
 AND EXISTS (SELECT 1 FROM public.market_orders o WHERE o.user_id=l.user_id AND o.status='pending' AND o.expires_at>now())
 ORDER BY l.user_id LIMIT greatest(0,least(p_limit,100));
$$;
REVOKE ALL ON FUNCTION public.whatsapp_reminder_candidates(uuid,boolean,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.whatsapp_reminder_candidates(uuid,boolean,integer) TO service_role;
COMMIT;
