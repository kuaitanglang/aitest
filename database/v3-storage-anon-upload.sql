-- ============================================================
-- 前端直传 Storage 方案：允许 anon（浏览器）上传文件到 import-files bucket
-- ============================================================
-- 背景：
--   上传接口优化为先创建任务（≤1s 返回 task_id），文件由前端直传 Supabase Storage，
--   不再经过 Vercel 中转，大文件上传不再阻塞接口响应。
--   Storage 服务在 upload 时会先 SELECT 检查对象存在性，因此 anon 需同时具备
--   SELECT / INSERT / UPDATE / DELETE 四类 policy（均限定在 import-files bucket）。

DO $$
BEGIN
  -- INSERT：上传新对象
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage' AND tablename = 'objects'
      AND policyname = 'anon_upload_import_files'
  ) THEN
    EXECUTE 'CREATE POLICY "anon_upload_import_files"
             ON storage.objects FOR INSERT TO anon
             WITH CHECK (bucket_id = ''import-files'')';
  END IF;

  -- SELECT：Storage 服务检查对象存在性
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage' AND tablename = 'objects'
      AND policyname = 'anon_read_import_files'
  ) THEN
    EXECUTE 'CREATE POLICY "anon_read_import_files"
             ON storage.objects FOR SELECT TO anon
             USING (bucket_id = ''import-files'')';
  END IF;

  -- UPDATE：upsert / 覆盖上传
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage' AND tablename = 'objects'
      AND policyname = 'anon_update_import_files'
  ) THEN
    EXECUTE 'CREATE POLICY "anon_update_import_files"
             ON storage.objects FOR UPDATE TO anon
             USING (bucket_id = ''import-files'')
             WITH CHECK (bucket_id = ''import-files'')';
  END IF;

  -- DELETE：前端重传时清理旧对象
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage' AND tablename = 'objects'
      AND policyname = 'anon_delete_import_files'
  ) THEN
    EXECUTE 'CREATE POLICY "anon_delete_import_files"
             ON storage.objects FOR DELETE TO anon
             USING (bucket_id = ''import-files'')';
  END IF;
END $$;
