-- 018: service-only candidate enumeration. The existing atomic claim in 017 is authoritative.
BEGIN;
CREATE INDEX market_orders_pending_owner_expiry ON public.market_orders(user_id,expires_at) WHERE status='pending';
CREATE FUNCTION public.whatsapp_reminder_candidates(p_after uuid,p_template boolean,p_limit integer)
RETURNS TABLE(user_id uuid,channel_id uuid) LANGUAGE sql STABLE SECURITY INVOKER SET search_path=public AS $$
 SELECT l.user_id,l.channel_id FROM public.whatsapp_links l
 WHERE (p_after IS NULL OR l.user_id>p_after) AND (l.phone IS NOT NULL OR l.bsuid IS NOT NULL)
 AND (l.last_reminder IS NULL OR l.last_reminder<=now()-interval '24 hours')
 AND (p_template OR l.last_inbound>now()-interval '24 hours')
 AND EXISTS (SELECT 1 FROM public.market_orders o WHERE o.user_id=l.user_id AND o.status='pending' AND o.expires_at>now())
 ORDER BY l.user_id LIMIT greatest(0,least(p_limit,100));
$$;
REVOKE ALL ON FUNCTION public.whatsapp_reminder_candidates(uuid,boolean,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.whatsapp_reminder_candidates(uuid,boolean,integer) TO service_role;
COMMIT;
