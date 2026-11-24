interface SiriOrbProps {
  className?: string;
}

/** Animated liquid orb for the empty-chat greeting — layered, blurred,
 * independently-morphing blobs in the brand teal/accent palette (no purple),
 * standing in for a static dot. Pure CSS (see .siri-orb rules in index.css)
 * so it costs nothing at runtime and respects prefers-reduced-motion. */
export function SiriOrb({ className }: SiriOrbProps) {
  return (
    <div className={`siri-orb ${className ?? ""}`} aria-hidden="true">
      <span className="siri-orb-blob siri-orb-blob-a" />
      <span className="siri-orb-blob siri-orb-blob-b" />
      <span className="siri-orb-blob siri-orb-blob-c" />
    </div>
  );
}
