-- Apply to the configured Supabase database before deploying the new message writer.
-- Additive: existing data, policies and grants are preserved. Do not drop this column on app rollback.
BEGIN;
ALTER TABLE public.chat_messages ADD COLUMN IF NOT EXISTS metadata jsonb;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'chat_messages'
      AND column_name = 'metadata' AND data_type = 'jsonb'
  ) THEN
    RAISE EXCEPTION 'chat_messages.metadata must be jsonb';
  END IF;
END $$;
COMMIT;
