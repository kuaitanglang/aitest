import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

const taskId = 'task_1786073049946_aff01e8f';

async function main() {
  // 1. Query batches with service_role key
  const admin = createClient(supabaseUrl, serviceKey);
  console.log('=== Batches (service_role) ===');
  const { data: batchesAdmin, error: e1 } = await admin
    .from('v3_import_task_batches')
    .select('unit_id, batch_index, status')
    .eq('task_id', taskId)
    .order('batch_index', { ascending: true });
  if (e1) console.error('Error:', e1.message);
  else batchesAdmin?.forEach(b => console.log(`  ${b.unit_id}: status=${b.status}`));

  // 2. Query batches with anon key
  const anon = createClient(supabaseUrl, anonKey);
  console.log('\n=== Batches (anon) ===');
  const { data: batchesAnon, error: e2 } = await anon
    .from('v3_import_task_batches')
    .select('unit_id, batch_index, status')
    .eq('task_id', taskId)
    .order('batch_index', { ascending: true });
  if (e2) console.error('Error:', e2.message);
  else batchesAnon?.forEach(b => console.log(`  ${b.unit_id}: status=${b.status}`));

  // 3. Query perf log with service_role key
  console.log('\n=== PerfLog (service_role) ===');
  const { data: perfAdmin, error: e3 } = await admin
    .from('v3_batch_performance_log')
    .select('unit_id, batch_index, rows_success, rows_failed, total_duration_ms')
    .eq('task_id', taskId)
    .order('batch_index', { ascending: true });
  if (e3) console.error('Error:', e3.message);
  else {
    console.log(`  Count: ${perfAdmin?.length || 0}`);
    perfAdmin?.forEach(p => console.log(`  ${p.unit_id}: success=${p.rows_success} failed=${p.rows_failed} ${p.total_duration_ms}ms`));
  }

  // 4. Query perf log with anon key
  console.log('\n=== PerfLog (anon) ===');
  const { data: perfAnon, error: e4 } = await anon
    .from('v3_batch_performance_log')
    .select('unit_id, batch_index, rows_success, rows_failed, total_duration_ms')
    .eq('task_id', taskId)
    .order('batch_index', { ascending: true });
  if (e4) console.error('Error:', e4.message);
  else {
    console.log(`  Count: ${perfAnon?.length || 0}`);
    perfAnon?.forEach(p => console.log(`  ${p.unit_id}: success=${p.rows_success} failed=${p.rows_failed} ${p.total_duration_ms}ms`));
  }
}

main().catch(console.error);
