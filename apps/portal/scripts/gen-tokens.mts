import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildCss } from "../src/design/design-tokens";

const out = join(import.meta.dirname, "../src/design/tokens.generated.css");
writeFileSync(out, buildCss());
console.log(`wrote ${out}`);
