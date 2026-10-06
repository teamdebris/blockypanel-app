function ThemedMark({ name, className }: { name: string; className?: string }) {
  return <>
    {/* eslint-disable-next-line @next/next/no-img-element -- a tiny static SVG; next/image adds nothing here */}
    <img src={`/brand/${name}-light.svg`} alt="" aria-hidden className={`${className ?? ""} dark:hidden`} />
    {/* eslint-disable-next-line @next/next/no-img-element */}
    <img src={`/brand/${name}-dark.svg`} alt="" aria-hidden className={`${className ?? ""} hidden dark:block`} />
  </>;
}

/** The Blocky Panel mark: a faceted green cube. The dark-theme version is tuned brighter. */
export function BlockyMark({ className }: { className?: string }) {
  return <ThemedMark name="blocky-panel-mark" className={className} />;
}

/** The Blocky Cloud mark: the same cube in blue, with a cloud on its face. */
export function CloudMark({ className }: { className?: string }) {
  return <ThemedMark name="blocky-cloud-mark" className={className} />;
}
