// Schema-derived contract for Task008. Regenerate with Supabase CLI after migration.
export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];
export type TradeRow = {
  id: string; user_id: string; pair: string; side: string; status: string; quantity: number;
  entry_price: number; exit_price: number | null; opened_at: string; closed_at: string | null;
  stop_loss: number | null; take_profit: number | null; realized_pnl: number | null; notes: string | null;
  analysis_snapshot: Json | null; // Task007 legacy or Task013 version=1 AI/chart snapshot; immutable after insert
  local_trade_id: string | null; created_at: string; updated_at: string; version: number;
}
export type SettingsRow = { user_id: string; current_capital: number; target_capital: number; risk_percent: number; trade_unit: number; created_at: string; updated_at: string; version: number }
type Table<Row> = { Row: Row; Insert: Partial<Row>; Update: Partial<Row>; Relationships: [] };
export interface Database {
  public: {
    Tables: { trades: Table<TradeRow>; user_settings: Table<SettingsRow>; profiles: Table<{ id: string; display_name: string | null; created_at: string; updated_at: string }> };
    Views: { [_ in never]: never };
    Functions: { import_local_trades: { Args: { payload: Json }; Returns: number } };
    Enums: { [_ in never]: never }; CompositeTypes: { [_ in never]: never };
  };
}
