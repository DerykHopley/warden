// The Products page (stories 1 and 2, read half): every Product of the Team, with its Repo URLs and the frameworks it
// uses, the same for every Role. Nothing here changes a Product: the form for a Lead or an Admin comes later.
import type { Framework, Product, ProductDependency } from "@warden/contracts";
import { useCallback } from "react";
import { askAboutTeam, type GetToken } from "./api.ts";
import type { PageProps } from "./App.tsx";
import { fetchFrameworks, fetchProducts, USAGE_WORDS, type ProductsResult } from "./products.ts";
import { CallRefused, TeamRefused, useWardenCall } from "./warden-call.tsx";

/** The frameworks' display names by id: null when the frameworks couldn't be read in time. */
type FrameworkNames = ReadonlyMap<string, string> | null;

/** The Products, with the frameworks' display names. */
type ProductsView =
  | Exclude<ProductsResult, { kind: "products" }>
  | { kind: "products"; products: Product[]; names: FrameworkNames };

/** How long the list waits for the frameworks' names before it shows their ids instead. */
export const FRAMEWORKS_WAIT_MS = 3000;

const namesOf = (frameworks: Framework[]) =>
  new Map(frameworks.map(({ id, name }) => [id, name] as const));

/**
 * The frameworks' names, or null when their call fails or takes longer than FRAMEWORKS_WAIT_MS: they only name things.
 * A session that ended is passed on, so the page ends it.
 */
async function frameworkNames(
  getToken: GetToken,
): Promise<FrameworkNames | { kind: "session-ended" }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), FRAMEWORKS_WAIT_MS);
  });
  const answer = await Promise.race([fetchFrameworks(getToken), late]);
  clearTimeout(timer);
  if (answer === null || answer.kind === "session-ended") return answer;
  return answer.kind === "frameworks" ? namesOf(answer.frameworks) : null;
}

export function ProductsPage({ getToken, me, onSessionEnded }: PageProps) {
  // Both calls at once. A refusal of the list shows as soon as it comes. The list itself waits for the frameworks'
  // names, so a framework's id doesn't show for a moment before its name; without them in time, it shows the ids.
  const team = me.team;
  const ask = useCallback(
    async (signal: AbortSignal): Promise<ProductsView> => {
      const names = frameworkNames(getToken);
      const products = await askAboutTeam(
        () => fetchProducts(getToken),
        (result) => (result.kind === "products" ? result.team : undefined),
        team,
        signal,
      );
      if (products.kind !== "products") return products;
      const frameworks = await names;
      if (frameworks !== null && "kind" in frameworks) return frameworks;
      return { kind: "products", products: products.products, names: frameworks };
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

function ProductEntry({ product, names }: { product: Product; names: FrameworkNames }) {
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
            <p className="muted">No Dependencies.</p>
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
  names: FrameworkNames;
}) {
  const { framework, version, usage, internet_facing: internetFacing } = dependency;
  // The spaces between the parts keep them apart for a screen reader; the row's flex gap spaces them on screen.
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
