import { redirect } from "next/navigation";

export default async function RankingPage() {
  redirect("/map?ranking=1");
}
