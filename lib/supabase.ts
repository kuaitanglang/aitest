import { createClient } from '@supabase/supabase-js'

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY

export const supabase = (supabaseUrl && supabaseKey && supabaseUrl.startsWith('http'))
  ? createClient(supabaseUrl, supabaseKey)
  : null;