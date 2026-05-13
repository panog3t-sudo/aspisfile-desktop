import { createClient } from "@supabase/supabase-js";

declare const __SUPABASE_URL__: string;
declare const __SUPABASE_ANON_KEY__: string;

export const supabase = createClient(__SUPABASE_URL__, __SUPABASE_ANON_KEY__);
