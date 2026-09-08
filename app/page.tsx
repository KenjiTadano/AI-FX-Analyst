import { Dashboard } from "@/components/dashboard/dashboard";
import { mockAccount, mockAnalyses } from "@/lib/mock-analysis";

export default function Home() {
  return <Dashboard analyses={mockAnalyses} account={mockAccount} />;
}
