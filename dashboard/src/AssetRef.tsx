import type { Asset } from "@warden/contracts";
import { productHref } from "./products.ts";

/**
 * A Finding's Asset by name, in the Findings table and the detail card (#210): a Product's name (`productName`, null
 * for an Asset that isn't one of the Team's Products) is a link to its entry on the Products page; otherwise the
 * Asset's ref, as text. A click on the link is the link's alone: it doesn't also select the table row it sits in.
 */
export function AssetRef({ asset, productName }: { asset: Asset; productName: string | null }) {
  if (productName === null) return <span className="asset-ref">{asset.ref}</span>;
  return (
    <a
      className="asset-ref asset-link"
      href={productHref(asset.ref)}
      onClick={(event) => event.stopPropagation()}
    >
      {productName}
    </a>
  );
}
