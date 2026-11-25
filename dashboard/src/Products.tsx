// The Products page (stories 1 and 2, read half): every Product of the Team, with its Repo URLs and the frameworks it
// uses, the same for every Role. Nothing here changes a Product: the form for a Lead or an Admin comes later.
import type { Framework, Product, ProductDependency } from "@warden/contracts";
import { useCallback } from "react";
import { askAboutTeam } from "./api.ts";
import type { PageProps } from "./App.tsx";
import { fetchFrameworks, fetchProducts, USAGE_WORDS, type ProductsResult } from "./products.ts";
import { CallRefused, TeamRefused, useWardenCall } from "./warden-call.tsx";

/** The Products, with the frameworks' display names by id: null when the frameworks couldn't be read. */
type ProductsView =
  | Exclude<ProductsResult, { kind: "products" }>
  | { kind: "products"; products: Product[]; names: ReadonlyMap<string, string> | null };

const namesOf = (frameworks: Framework[]) =>
  new Map(frameworks.map(({ id, name }) => [id, name] as const));

export function ProductsPage({ getToken, me, onSessionEnded }: PageProps) {
  // Both calls at once, and the page waits for both, so a framework's id never shows for a moment before its name. The
  // frameworks only name things: without them the list still shows, with each framework's id.
  const team = me.team;
  const ask = useCallback(
    async (signal: AbortSignal): Promise<ProductsView> => {
      const [products, frameworks] = await Promise.all([
        askAboutTeam(
          () => fetchProducts(getToken),
          (result) => (result.kind === "products" ? result.team : undefined),
          team,
          signal,
        ),
        fetchFrameworks(getToken),
      ]);
      if (products.kind !== "products") return products;
      return {
        kind: "products",
        products: products.products,
        names: frameworks.kind === "frameworks" ? namesOf(frameworks.frameworks) : null,
      };
    },
    [getToken, team],
  );
  const list = useWardenCall<ProductsView>(ask, onSessionEnded);
  const view = list.result !== "loading" && list.result.kind === "products" ? list.result : null;

  return (
    <>
      <h1>Products</h1>
      {list.result === "loading" && <p className="muted">Loading Products…</p>}
      {list.result !== "loading" && <CallRefused result={list.result} onRetry={list.retry} />}
      {list.result !== "loading" && <TeamRefused result={list.result} />}
      {view?.products.length === 0 && (
        <>
          <p className="muted">No Products yet.</p>
          {me.role === "member" && <p className="muted">A Lead or an Admin adds them.</p>}
        </>
      )}
      {view !== null && view.products.length > 0 && (
        <ul className="products">
          {view.products.map((product) => (
            <ProductEntry key={product.id} product={product} names={view.names} />
          ))}
        </ul>
      )}
    </>
  );
}

function ProductEntry({
  product,
  names,
}: {
  product: Product;
  names: ReadonlyMap<string, string> | null;
}) {
  const reposId = `repos-${product.id}`;
  const dependenciesId = `dependencies-${product.id}`;
  return (
    <li className="product">
      <h2 className="product-name">{product.name}</h2>
      <div className="product-parts">
        <section className="product-part">
          <h3 id={reposId}>Repo URLs</h3>
          {product.repo_urls.length === 0 ? (
            <p className="muted">No Repo URLs.</p>
          ) : (
            <ul className="repo-urls" aria-labelledby={reposId}>
              {product.repo_urls.map((url) => (
                <li key={url}>
                  <a href={url} target="_blank" rel="noopener noreferrer">
                    {url}
                  </a>
                </li>
              ))}
            </ul>
          )}
        </section>
        <section className="product-part">
          <h3 id={dependenciesId}>Dependencies</h3>
          {product.dependencies.length === 0 ? (
            <p className="muted">No dependencies.</p>
          ) : (
            <ul className="dependencies" aria-labelledby={dependenciesId}>
              {product.dependencies.map((dependency) => (
                <DependencyRow key={dependency.framework} dependency={dependency} names={names} />
              ))}
            </ul>
          )}
        </section>
      </div>
    </li>
  );
}

/** One framework a Product uses: its name (its id when the name isn't known), version, usage and internet-facing. */
function DependencyRow({
  dependency,
  names,
}: {
  dependency: ProductDependency;
  names: ReadonlyMap<string, string> | null;
}) {
  const { framework, version, usage, internet_facing: internetFacing } = dependency;
  // The spaces between the parts keep them apart for a screen reader; the grid's gap spaces them on screen.
  return (
    <li className="dependency">
      <span className="dependency-name">{names?.get(framework) ?? framework}</span>{" "}
      {version === null ? (
        <span className="dependency-version muted">version unknown</span>
      ) : (
        <code className="dependency-version">{version}</code>
      )}{" "}
      <span className="dependency-usage">{USAGE_WORDS[usage]}</span>
      {internetFacing && (
        <>
          {" "}
          <span className="dependency-flag">internet-facing</span>
        </>
      )}
    </li>
  );
}
