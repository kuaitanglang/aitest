import { createClient } from '@supabase/supabase-js';

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

async function main() {
  const TASK_ID = 'task_1786078970377_cd028329';

  // 查看 outbox 中 ImportBatchCreated 的 payload
  const { data: outbox } = await sb
    .from('v3_event_outbox')
    .select('event_type, payload, status')
    .eq('aggregate_id', TASK_ID)
    .limit(2);
  console.log('=== Outbox payload structure ===');
  for (const o of outbox || []) {
    console.log(`event_type: ${o.event_type}`);
    console.log(`payload: ${JSON.stringify(o.payload, null, 2)}`);
    console.log(`payload.trace_id: ${(o.payload as any)?.trace_id}`);
    console.log(`payload.payload: ${JSON.stringify((o.payload as any)?.payload)}`);
    console.log('---');
  }

  // 查看这个任务的 trace 事件
  const { data: traces } = await sb
    .from('v3_trace_events')
    .select('*')
    .eq('task_id', TASK_ID);
  console.log(`\n=== Trace events: ${traces?.length || 0} ===`);
  for (const t of traces || []) {
    console.log(`  ${t.event_name} | trace_id=${t.trace_id} | unit=${t.unit_id}`);
  }
}

main().catch(console.error);
