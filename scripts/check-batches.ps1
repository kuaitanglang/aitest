$envFile = "c:\Users\xiangzhian\Desktop\AI_WORK\ztocc-ai-work\.env.local"
Get-Content $envFile | ForEach-Object {
  if ($_ -match '^(NEXT_PUBLIC_SUPABASE_URL|NEXT_PUBLIC_SUPABASE_ANON_KEY|SUPABASE_SERVICE_ROLE_KEY)=(.*)$') {
    Set-Item -Path "env:$($matches[1])" -Value $matches[2]
  }
}

$baseUrl = $env:NEXT_PUBLIC_SUPABASE_URL
$anonKey = $env:NEXT_PUBLIC_SUPABASE_ANON_KEY
$serviceKey = $env:SUPABASE_SERVICE_ROLE_KEY
$taskId = "task_1786073049946_aff01e8f"

$h = @{ "apikey" = $anonKey; "Authorization" = "Bearer $serviceKey" }

# Batches - raw response body
[Console]::WriteLine("=== Batches (service_role) ===")
$url1 = "$baseUrl/rest/v1/v3_import_task_batches?select=unit_id,batch_index,status&task_id=eq.$taskId&order=batch_index.asc"
$resp1 = Invoke-WebRequest -Uri $url1 -Headers $h -TimeoutSec 10
[Console]::WriteLine($resp1.Content)

# PerfLog - raw response body
[Console]::WriteLine("`n=== PerfLog (service_role) ===")
$url2 = "$baseUrl/rest/v1/v3_batch_performance_log?select=unit_id,batch_index,rows_success,rows_failed,total_duration_ms&task_id=eq.$taskId&order=batch_index.asc"
$resp2 = Invoke-WebRequest -Uri $url2 -Headers $h -TimeoutSep 10
[Console]::WriteLine($resp2.Content)
