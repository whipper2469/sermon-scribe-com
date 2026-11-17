import { createClient } from "jsr:@supabase/supabase-js@2";
import { requiredEnv } from "./http.ts";

type ConnectDatabase = {
  public: {
    Tables: {
      stripe_connect_accounts: {
        Row: {
          user_id: string;
          account_id: string;
          public_slug: string;
          store_name: string;
          card_payments_status: string | null;
          requirements_status: string | null;
          updated_at: string;
          created_at: string;
        };
        Insert: {
          user_id: string;
          account_id: string;
          public_slug: string;
          store_name?: string;
          card_payments_status?: string | null;
          requirements_status?: string | null;
          updated_at?: string;
          created_at?: string;
        };
        Update: Partial<{
          user_id: string;
          account_id: string;
          public_slug: string;
          store_name: string;
          card_payments_status: string | null;
          requirements_status: string | null;
          updated_at: string;
          created_at: string;
        }>;
        Relationships: [];
      };
    };
    Views: Record<never, never>;
    Functions: Record<never, never>;
    Enums: Record<never, never>;
    CompositeTypes: Record<never, never>;
  };
};

export async function signedInUser(req: Request) {
  const authorization = req.headers.get("Authorization");
  if (!authorization?.startsWith("Bearer ")) {
    throw new Error("Missing or invalid Authorization header");
  }
  const admin = createClient<ConnectDatabase>(
    requiredEnv(
      "SUPABASE_URL",
      "Set the Supabase project URL for Edge Functions.",
    ),
    requiredEnv(
      "SUPABASE_SERVICE_ROLE_KEY",
      "Set the Supabase service-role secret for Edge Functions.",
    ),
  );
  const { data: { user }, error } = await admin.auth.getUser(
    authorization.slice(7),
  );
  if (error || !user) throw new Error("Invalid session");
  return { user, admin };
}
