import Link from "next/link";
import { Mascot } from "@/components/ui/Mascot";

/** The P-Dot home link: the mascot and the name. The mascot is hidden from screen readers, so the link's name is "P-Dot". */
export function BrandLink({ href = "/" }: { href?: string }) {
  return (
    <Link href={href} className="brand">
      <Mascot className="brand-mascot" size={28} />
      P-Dot
    </Link>
  );
}
