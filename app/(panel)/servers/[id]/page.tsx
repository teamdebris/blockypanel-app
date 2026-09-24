import { ServerPage } from "@/components/panel/server-page";

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ServerPage serverId={id} tab="overview" />;
}
