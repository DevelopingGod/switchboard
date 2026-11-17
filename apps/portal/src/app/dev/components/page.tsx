import type { Metadata } from "next";
import { Gallery } from "./Gallery";

export const metadata: Metadata = { title: "Components" };

export default function Page() {
  return <Gallery />;
}
