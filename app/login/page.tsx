import { AuthForm } from "@/components/auth/form";
export default async function Login({ searchParams }: { searchParams: Promise<{ error?: string; notice?: string }> }) {
  const params = await searchParams;
  return <>{params.error === "confirmation" && <p className="auth-confirm-error" role="alert">メール確認に失敗しました。リンクの有効期限・使用済みかを確認して、ログインをお試しください。</p>}{params.notice === "confirmation-login" && <p className="auth-confirm-error" role="status">メール確認後の自動ログインを完了できませんでした。確認済みの場合は、登録したメールアドレスとパスワードでログインしてください。</p>}{params.notice === "confirmation-unavailable" && <p className="auth-confirm-error" role="status">認証サービスの応答を確認できませんでした。時間をおいてログインをお試しください。</p>}<AuthForm /></>;
}
