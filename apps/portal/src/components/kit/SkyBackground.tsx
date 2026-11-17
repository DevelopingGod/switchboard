/** Fixed backdrop: CSS gradient sky with slow cloud drift (optional bitmap sky via [data-sky=image]). */
export function SkyBackground() {
  return (
    <div aria-hidden className="sky">
      <span className="sky-cloud" />
      <span className="sky-cloud" />
      <span className="sky-cloud" />
    </div>
  );
}
