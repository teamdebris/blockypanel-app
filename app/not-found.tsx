import Link from "next/link";
import { Button } from "@/components/ui/button";
import { BlockArt } from "@/components/panel/server-icon";

export default function NotFound() {
  return <main className="grid min-h-screen place-items-center bg-background p-6 text-center text-foreground">
    <div>
      <BlockArt name="zombie" className="mx-auto mb-4 size-20" />
      <h1 className="font-display text-2xl font-bold tracking-[-.03em]">This chunk didn&apos;t load</h1>
      <p className="mt-2 text-sm text-muted-foreground">There&apos;s no page at this address.</p>
      <Button asChild className="mt-5"><Link href="/">Back to the overview</Link></Button>
    </div>
  </main>;
}
