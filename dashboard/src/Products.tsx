// The Products page (stories 1 and 2): every Product of the Team, with its Repo URLs and the frameworks it uses, the
// same list for every Role. A Lead or an Admin adds and changes Products in a form on the page, and deletes them after
// a confirm; a Member is offered no change. The server checks the Role on every change: the page only hides what the
// server would refuse.
import {
  PRODUCT_NAME_MAX,
  PRODUCT_REPO_URLS_MAX,
  Usage,
  type Framework,
  type Product,
  type ProductDependency,
  type ProductInput,
} from "@warden/contracts";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import { NOT_ANSWERING, TEAM_NOT_OPENED, tryAgainIn, type GetToken } from "./api.ts";
import type { PageProps } from "./App.tsx";
import { useLandOnAnchor } from "./land-on-anchor.ts";
import {
  askProducts,
  deleteProductInTeam,
  fetchFrameworks,
  productAnchor,
  rereadsAfterDrop,
  saveProductInTeam,
  USAGE_WORDS,
  type DeleteResult,
  type ProductsResult,
  type SaveResult,
  type TeamCheckRefused,
} from "./products.ts";
import { CallRefused, TeamRefused, useWardenCall } from "./warden-call.tsx";

/** A Product's entry's name takes focus, once the page has brought the entry into view itself. */
const focusEntryName = (entry: HTMLElement) =>
  entry.querySelector<HTMLElement>(".product-name")?.focus({ preventScroll: true });

/** The frameworks' display names by id, in the API's order: null when the frameworks couldn't be read in time. */
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

/** One dependency row as typed: the version as text ("" is unknown). `key` keeps the row's fields while rows move. */
type DependencyDraft = {
  key: number;
  framework: string;
  version: string;
  usage: Usage;
  internetFacing: boolean;
};

/** What the Product form holds while it's open: kept as typed after a refusal. */
type ProductDraft = {
  name: string;
  repoUrls: { key: number; url: string }[];
  dependencies: DependencyDraft[];
};

/**
 * The open form: the Team it was opened in, the Product it changes (null: a new one) and its name as Edit opened it
 * (the form's own name, kept if the list later loses the Product), the frameworks it was opened with (a later read of
 * the list may fail to name them), what's typed, and its refusal line.
 */
type OpenForm = {
  team: string | null;
  id: string | null;
  name: string;
  frameworks: ReadonlyMap<string, string>;
  draft: ProductDraft;
  refusal: string | null;
};

/** The open delete confirm: the Team it was opened in, the Product it deletes, and its refusal line. */
type OpenConfirm = { team: string | null; id: string; refusal: string | null };

let lastRowKey = 0;
const rowKey = () => ++lastRowKey;

const EMPTY_DRAFT: ProductDraft = { name: "", repoUrls: [], dependencies: [] };

/** Edit's form opens with the Product as listed. */
const draftOf = (product: Product): ProductDraft => ({
  name: product.name,
  repoUrls: product.repo_urls.map((url) => ({ key: rowKey(), url })),
  dependencies: product.dependencies.map((dependency) => ({
    key: rowKey(),
    framework: dependency.framework,
    version: dependency.version ?? "",
    usage: dependency.usage,
    internetFacing: dependency.internet_facing,
  })),
});

/** The Repo URL rows a save sends, by their place on screen: a blank row is left out. */
const sentRows = (draft: ProductDraft) =>
  draft.repoUrls.flatMap(({ url }, row) => (url.trim() === "" ? [] : [row]));

/** What a save sends: a blank Repo URL row left out, a blank version as null. */
const inputOf = (draft: ProductDraft): ProductInput => ({
  name: draft.name,
  repo_urls: sentRows(draft).map((row) => draft.repoUrls[row]!.url.trim()),
  dependencies: draft.dependencies.map((dependency) => ({
    framework: dependency.framework,
    version: dependency.version.trim() === "" ? null : dependency.version.trim(),
    usage: dependency.usage,
    internet_facing: dependency.internetFacing,
  })),
});

/** The list with `saved` in it: in its entry's place on a change, last when new, until the list is read again. */
function withSaved(old: ProductsView | "loading", saved: Product): ProductsView | "loading" {
  if (old === "loading" || old.kind !== "products") return old;
  const known = old.products.some(({ id }) => id === saved.id);
  return {
    ...old,
    products: known
      ? old.products.map((product) => (product.id === saved.id ? saved : product))
      : [...old.products, saved],
  };
}

/**
 * A 400's words with each `repo_urls.N` named as the row on screen ("Repo URL 3"): the server counts the Repo URLs
 * sent from 0, and a blank row on screen wasn't sent.
 */
function onScreen(error: string, draft: ProductDraft): string {
  const rows = sentRows(draft);
  return error.replace(/\brepo_urls\.(\d+)\b/g, (words, sent: string) => {
    const row = rows[Number(sent)];
    return row === undefined ? words : `Repo URL ${row + 1}`;
  });
}

const REFUSED = "Warden refused this change.";
const FORBIDDEN = "Only a Lead or an Admin can change Products.";
const PRODUCT_GONE = "This Product is no longer in your Team.";
const MAYBE_SAVED =
  "Warden's server didn't answer, so the change may have been saved. Check the list before you try again.";

/** A refusal a save and a delete share, the Team check's included: each shows in its own refusal line alike. */
type ChangeRefused = Exclude<
  SaveResult | DeleteResult | TeamCheckRefused,
  { kind: "saved" | "invalid" | "not-found" | "maybe-saved" | "deleted" }
>;

/**
 * A keydown handler that runs `cancel` on Esc, unless a control inside took the key first or an input method is
 * composing.
 */
const onEscape = (cancel: () => void) => (event: KeyboardEvent) => {
  if (event.key !== "Escape" || event.defaultPrevented || event.nativeEvent.isComposing) return;
  event.preventDefault();
  cancel();
};

export function ProductsPage({ getToken, me, onSessionEnded, refreshMe }: PageProps) {
  // Both calls at once. A refusal of the list shows as soon as it comes. The list itself waits for the frameworks'
  // names, so a framework's id doesn't show for a moment before its name; without them in time, it shows the ids.
  const team = me.team;
  const ask = useCallback(
    async (signal: AbortSignal): Promise<ProductsView> => {
      const names = frameworkNames(getToken);
      const products = await askProducts(getToken, team, signal);
      if (products.kind !== "products") return products;
      const frameworks = await names;
      if (frameworks !== null && "kind" in frameworks) return frameworks;
      return { kind: "products", products: products.products, names: frameworks };
    },
    [getToken, team],
  );
  const list = useWardenCall<ProductsView>(ask, onSessionEnded);
  const view = list.result !== "loading" && list.result.kind === "products" ? list.result : null;
  const names = view?.names ?? null;

  const changes = me.role === "lead" || me.role === "admin";
  const [open, setOpen] = useState<OpenForm | null>(null);
  const [saving, setSaving] = useState(false);
  /**
   * The save under way, by an object of its own: a Team or Role change forgets it, so its answer is dropped and the
   * next form can save at once.
   */
  const saveCall = useRef<object | null>(null);
  const [askingNames, setAskingNames] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState<OpenConfirm | null>(null);
  const [deleting, setDeleting] = useState(false);
  /**
   * The delete under way, by an object of its own: a Team or Role change forgets it, so its answer is dropped and the
   * next confirm can delete at once.
   */
  const deleteCall = useRef<object | null>(null);
  /** The gone notice: a delete found the Product already gone (404). */
  const [gone, setGone] = useState(false);
  // A Team switch, or a Role that no longer changes Products (a 403, then /api/me's new answer), closes the form and
  // the confirm, so they don't come back if the Team or Role does, and forgets a save or a delete under way.
  const [formFor, setFormFor] = useState({ team, changes });
  if (formFor.team !== team || formFor.changes !== changes) {
    setFormFor({ team, changes });
    setOpen(null);
    setConfirmOpen(null);
    setSaving(false);
    setDeleting(false);
    setGone(false);
  }
  // The Team the page shows now, for a forgotten save whose answer arrives once its Team shows again.
  const teamNow = useRef(team);
  useEffect(() => {
    teamNow.current = team;
    saveCall.current = null;
    deleteCall.current = null;
  }, [team, changes]);
  // A confirm whose Product leaves the list goes, refusal and all, so a later read that lists it again doesn't bring
  // it back.
  if (
    confirmOpen !== null &&
    view !== null &&
    !view.products.some(({ id }) => id === confirmOpen.id)
  ) {
    setConfirmOpen(null);
  }
  const form = changes && open !== null && open.team === team ? open : null;
  // A confirm shows in its Product's entry, so it's open only while the list has that Product.
  const confirming =
    changes &&
    confirmOpen !== null &&
    confirmOpen.team === team &&
    view?.products.some(({ id }) => id === confirmOpen.id)
      ? confirmOpen
      : null;
  /** One at a time: while a form or a confirm is open, Add, every Edit and every Delete wait. */
  const oneOpen = form !== null || confirming !== null;

  /**
   * What takes focus once the next render lands, by its `data-focus`: an opener, the form's name, a Product's name,
   * one of the confirm's buttons, or the page's heading. Given several, the first that's there and enabled then.
   */
  const focusNext = useRef<string | readonly string[] | null>(null);
  useEffect(() => {
    const target = focusNext.current;
    if (target === null) return;
    focusNext.current = null;
    const candidates = [...document.querySelectorAll<HTMLElement>("[data-focus]")];
    for (const wanted of typeof target === "string" ? [target] : target) {
      const element = candidates.find(
        (candidate) => candidate.dataset.focus === wanted && !candidate.matches(":disabled"),
      );
      if (element !== undefined) return element.focus();
    }
  });

  // Opened at `#product-<id>` (a Product Asset's link on Findings, #210), that Product's entry comes into view and its
  // name takes focus once the list first shows. An anchor no listed Product has moves nothing.
  const listed = view?.products;
  const findEntry = useCallback(
    (anchor: string) =>
      listed?.some(({ id }) => productAnchor(id) === anchor)
        ? document.getElementById(anchor)
        : null,
    [listed],
  );
  useLandOnAnchor(view !== null, findEntry, focusEntryName);

  function openForm(
    product: Product | null,
    frameworks: ReadonlyMap<string, string>,
    draft: ProductDraft,
  ) {
    focusNext.current = "form-name";
    const [id, name] = product === null ? [null, ""] : [product.id, product.name];
    setGone(false);
    setOpen({ team, id, name, frameworks, draft, refusal: null });
  }

  function openConfirm(product: Product) {
    focusNext.current = "confirm-cancel";
    setGone(false);
    setConfirmOpen({ team, id: product.id, refusal: null });
  }

  /**
   * Shows a refusal a save and a delete share with `show`, in the form's or the confirm's refusal line. A 403 also asks
   * /api/me again, which closes the form or the confirm for a lowered Role; a session that ended ends instead.
   */
  function showRefusal(result: ChangeRefused, show: (refusal: string) => void) {
    switch (result.kind) {
      case "forbidden":
        show(FORBIDDEN);
        refreshMe();
        return;
      case "conflict":
      case "refused":
        return show(result.error ?? REFUSED);
      case "team-not-opened":
        return show(TEAM_NOT_OPENED);
      case "too-many-attempts":
        return show(tryAgainIn(result.retryAfter, "changes to Products"));
      case "too-many-sign-ins":
        return show(tryAgainIn(result.retryAfter));
      case "not-answering":
        return show(NOT_ANSWERING);
      case "session-ended":
        return onSessionEnded();
    }
  }

  /** Closes the confirm, focus back on its Product's Delete; not while its delete runs. */
  function cancelConfirm() {
    if (confirming === null || deleteCall.current !== null) return;
    focusNext.current = `delete:${confirming.id}`;
    setConfirmOpen(null);
  }

  /**
   * After a delete, or a 404 (the Product was already gone): the list without it until it's read again, and focus on
   * Add, or on the page's heading while Add waits for the frameworks.
   */
  function afterDelete(id: string) {
    setConfirmOpen(null);
    list.setResult((old) =>
      old === "loading" || old.kind !== "products"
        ? old
        : { ...old, products: old.products.filter((product) => product.id !== id) },
    );
    list.refresh();
    focusNext.current = ["add", "heading"];
  }

  /**
   * Shows a delete's refusal in the confirm, focus back on its Delete: the button turned disabled while the call ran,
   * which took focus off it, and Esc and Tab need focus in the confirm.
   */
  function refuseDelete(refusal: string) {
    focusNext.current = "confirm-delete";
    setConfirmOpen((old) => (old === null ? old : { ...old, refusal }));
  }

  async function remove() {
    if (confirming === null || deleteCall.current !== null) return;
    const { team: deletedIn, id } = confirming;
    const call = {};
    deleteCall.current = call;
    setDeleting(true);
    const result = await deleteProductInTeam(getToken, deletedIn, id);
    // A Team or Role change since forgot this delete: its answer is about a page no longer shown.
    if (deleteCall.current !== call) return;
    deleteCall.current = null;
    setDeleting(false);
    switch (result.kind) {
      case "deleted":
        return afterDelete(id);
      case "not-found":
        afterDelete(id);
        setGone(true);
        return;
      default:
        return showRefusal(result, refuseDelete);
    }
  }

  function cancel() {
    if (form === null) return;
    const listed = form.id !== null && view?.products.some(({ id }) => id === form.id);
    focusNext.current = listed ? `edit:${form.id}` : "add";
    setOpen(null);
  }

  const refuse = (refusal: string) => setOpen((old) => (old === null ? old : { ...old, refusal }));

  async function save(event: FormEvent) {
    event.preventDefault();
    if (form === null || saveCall.current !== null || form.draft.name.trim() === "") return;
    const { team: savedIn, id, draft } = form;
    const call = {};
    saveCall.current = call;
    setSaving(true);
    const result = await saveProductInTeam(getToken, savedIn, id, inputOf(draft));
    // A Team or Role change since forgot this save: its answer is about a form no longer shown. Back on the save's
    // Team, `rereadsAfterDrop` says whether its answer still reads the list again, so the list shows what's stored.
    if (saveCall.current !== call) {
      if (rereadsAfterDrop(result) && teamNow.current === savedIn) list.refresh();
      return;
    }
    saveCall.current = null;
    setSaving(false);
    switch (result.kind) {
      case "saved":
        list.setResult((old) => withSaved(old, result.product));
        list.refresh();
        focusNext.current = `name:${result.product.id}`;
        setOpen(null);
        return;
      case "invalid":
        return refuse(result.error === null ? REFUSED : onScreen(result.error, draft));
      case "not-found":
        refuse(PRODUCT_GONE);
        list.refresh();
        return;
      case "maybe-saved":
        refuse(MAYBE_SAVED);
        list.refresh();
        return;
      default:
        return showRefusal(result, refuse);
    }
  }

  /** Asks for the frameworks again; once they answer, the list names them and Add and Edit turn on. */
  async function askNamesAgain() {
    setAskingNames(true);
    const names = await frameworkNames(getToken);
    setAskingNames(false);
    if (names === null) return;
    if ("kind" in names) return onSessionEnded();
    list.setResult((old) =>
      old === "loading" || old.kind !== "products" ? old : { ...old, names },
    );
  }

  const productForm = (current: OpenForm) => (
    <ProductForm
      label={current.id === null ? "Add a Product" : `Edit ${current.name}`}
      frameworks={current.frameworks}
      draft={current.draft}
      onDraft={(draft) => setOpen((old) => (old === null ? old : { ...old, draft }))}
      refusal={current.refusal}
      busy={saving}
      onSubmit={(event) => void save(event)}
      onCancel={cancel}
    />
  );
  // Edit's form takes its entry's place; Add's, and an Edit whose Product left the list (a 404), sits above the list.
  const formAbove =
    form !== null && (form.id === null || !view?.products.some(({ id }) => id === form.id));

  return (
    <>
      {/* Focus lands here after a delete while Add waits, so it takes focus from script only. */}
      <h1 tabIndex={-1} data-focus="heading">
        Products
      </h1>
      {gone && (
        <p className="notice" role="alert">
          {PRODUCT_GONE}
        </p>
      )}
      {list.result === "loading" && <p className="muted">Loading Products…</p>}
      {list.result !== "loading" && <CallRefused result={list.result} onRetry={list.retry} />}
      {list.result !== "loading" && <TeamRefused result={list.result} />}
      {view !== null && changes && (
        <div className="products-toolbar">
          <button
            type="button"
            className="primary"
            data-focus="add"
            disabled={names === null || oneOpen}
            onClick={() => names !== null && openForm(null, names, EMPTY_DRAFT)}
          >
            Add a Product
          </button>
          {names === null && (
            <>
              <p className="form-note">Couldn't load the frameworks.</p>
              <button
                type="button"
                className="secondary"
                disabled={askingNames}
                aria-busy={askingNames ? "true" : undefined}
                onClick={() => void askNamesAgain()}
              >
                Retry
              </button>
            </>
          )}
        </div>
      )}
      {formAbove && <div className="product product-adding">{productForm(form)}</div>}
      {view?.products.length === 0 && (
        <>
          <p className="muted">No Products yet.</p>
          {me.role === "member" && <p className="muted">A Lead or an Admin adds them.</p>}
        </>
      )}
      {view !== null && view.products.length > 0 && (
        <ul className="products">
          {view.products.map((product) =>
            form?.id === product.id ? (
              <li key={product.id} className="product">
                {productForm(form)}
              </li>
            ) : (
              <ProductEntry
                key={product.id}
                product={product}
                names={view.names}
                changes={
                  changes
                    ? {
                        onEdit: () => names !== null && openForm(product, names, draftOf(product)),
                        editDisabled: names === null || oneOpen,
                        onDelete: () => openConfirm(product),
                        deleteDisabled: oneOpen,
                        confirm:
                          confirming?.id === product.id
                            ? {
                                refusal: confirming.refusal,
                                busy: deleting,
                                onConfirm: () => void remove(),
                                onCancel: cancelConfirm,
                              }
                            : null,
                      }
                    : null
                }
              />
            ),
          )}
        </ul>
      )}
    </>
  );
}

/** A Lead's or an Admin's controls on one Product: Edit, Delete, and Delete's confirm while it's open. */
type EntryChanges = {
  onEdit: () => void;
  editDisabled: boolean;
  onDelete: () => void;
  deleteDisabled: boolean;
  confirm: ConfirmProps | null;
};

function ProductEntry({
  product,
  names,
  changes,
}: {
  product: Product;
  names: FrameworkNames;
  /** Null for a Role that can't change Products, which gets no Edit or Delete button. */
  changes: EntryChanges | null;
}) {
  const reposId = `repos-${product.id}`;
  const dependenciesId = `dependencies-${product.id}`;
  return (
    <li id={productAnchor(product.id)} className="product">
      <div className="product-head">
        {/* Focus lands here after a save, so it takes focus from script only. */}
        <h2 className="product-name" tabIndex={-1} data-focus={`name:${product.id}`}>
          {product.name}
        </h2>
        {changes !== null && (
          <div className="product-actions">
            <button
              type="button"
              className="secondary"
              aria-label={`Edit ${product.name}`}
              data-focus={`edit:${product.id}`}
              disabled={changes.editDisabled}
              onClick={changes.onEdit}
            >
              Edit
            </button>
            <button
              type="button"
              className="secondary"
              aria-label={`Delete ${product.name}`}
              data-focus={`delete:${product.id}`}
              disabled={changes.deleteDisabled}
              onClick={changes.onDelete}
            >
              Delete
            </button>
          </div>
        )}
      </div>
      {changes?.confirm && <DeleteConfirm product={product} {...changes.confirm} />}
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

type ConfirmProps = {
  refusal: string | null;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
};

/**
 * Delete's confirm, in its Product's entry: the question, its refusal line, and Delete (primary, busy while its call
 * runs) and Cancel. It opens with focus on Cancel, the safe choice; Esc anywhere in it cancels, as Cancel does, but
 * not while the delete runs, when both buttons wait.
 */
function DeleteConfirm({
  product,
  refusal,
  busy,
  onConfirm,
  onCancel,
}: { product: Product } & ConfirmProps) {
  const questionId = `delete-question-${product.id}`;
  return (
    <div
      className="delete-confirm"
      role="group"
      aria-labelledby={questionId}
      onKeyDown={onEscape(onCancel)}
    >
      <p id={questionId} className="delete-question">
        Delete {product.name}? Its CVE Findings turn Fixed.
      </p>
      {refusal !== null && (
        <p className="card-line refused" role="alert">
          {refusal}
        </p>
      )}
      <div className="form-actions">
        <button
          type="button"
          className="primary"
          data-focus="confirm-delete"
          disabled={busy}
          aria-busy={busy ? "true" : undefined}
          onClick={onConfirm}
        >
          Delete
        </button>
        <button
          type="button"
          className="secondary"
          data-focus="confirm-cancel"
          disabled={busy}
          onClick={onCancel}
        >
          Cancel
        </button>
      </div>
    </div>
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

/**
 * Add's or Edit's form: the name, one field per Repo URL, and one row per framework the Product uses (the framework,
 * its version, how it's used, internet-facing). Each control's name carries its row ("Version, LangChain"), so a
 * screen reader reads them apart. Save is disabled while the name is blank, and busy while its call (and the Patch
 * Scan it runs) is under way.
 */
/**
 * The `data-row-focus` value of each control in `ProductForm` that a vanished button hands focus to. Both the
 * attribute and the focus target come from here, so they can't drift apart.
 */
const rowFocus = {
  repoUrl: (key: number) => `repo-url:${key}`,
  addRepoUrl: "add-repo-url",
  framework: (key: number) => `framework:${key}`,
  addFramework: "add-framework",
} as const;

function ProductForm(props: {
  label: string;
  frameworks: ReadonlyMap<string, string>;
  draft: ProductDraft;
  onDraft: (draft: ProductDraft) => void;
  refusal: string | null;
  busy: boolean;
  onSubmit: (event: FormEvent) => void;
  onCancel: () => void;
}) {
  const { draft, frameworks, busy } = props;
  const set = (change: Partial<ProductDraft>) => props.onDraft({ ...draft, ...change });
  const setUrl = (key: number, url: string) =>
    set({ repoUrls: draft.repoUrls.map((row) => (row.key === key ? { key, url } : row)) });
  const setDependency = (key: number, change: Partial<DependencyDraft>) =>
    set({
      dependencies: draft.dependencies.map((row) =>
        row.key === key ? { ...row, ...change } : row,
      ),
    });
  const nameOf = (framework: string) => frameworks.get(framework) ?? framework;
  const picked = new Set(draft.dependencies.map(({ framework }) => framework));
  const unpicked = [...frameworks.keys()].filter((framework) => !picked.has(framework));

  // A button that goes away while it has focus (a row's Remove, an add button at its limit) hands focus to a control
  // in the form, by its `data-row-focus`, so it doesn't fall to the page and Esc still reaches the form: the next row,
  // else the row before, else the add button; an add button that goes hands it to the row it added.
  const formRef = useRef<HTMLFormElement>(null);
  const focusNext = useRef<string | null>(null);
  useEffect(() => {
    const target = focusNext.current;
    if (target === null) return;
    focusNext.current = null;
    [...(formRef.current?.querySelectorAll<HTMLElement>("[data-row-focus]") ?? [])]
      .find((element) => element.dataset.rowFocus === target)
      ?.focus();
  });
  /** After removing the row at `i` of `rows`: its neighbour's control (`control(key)`), else `add`. */
  const afterRemoving = (
    rows: readonly { key: number }[],
    i: number,
    control: (key: number) => string,
    add: string,
  ) => {
    const neighbour = rows[i + 1] ?? rows[i - 1];
    return neighbour === undefined ? add : control(neighbour.key);
  };

  // Enter in a Repo URL field doesn't save: a Remove (or the 20th "Add a Repo URL") hands focus to a Repo URL field, so
  // a second Enter meant for the button would otherwise submit the form there. Enter in Name, and Save, still save.
  function noSubmitOnEnter(event: KeyboardEvent) {
    if (event.key === "Enter" && !event.nativeEvent.isComposing) event.preventDefault();
  }

  return (
    // noValidate: the server checks each field and its 400 names the one that's wrong, in the refusal line. Esc
    // anywhere in the form cancels it (focus back on its opener), as a decision's form does; not while it saves.
    <form
      ref={formRef}
      className="product-form"
      aria-label={props.label}
      noValidate
      onSubmit={props.onSubmit}
      onKeyDown={onEscape(() => {
        if (!busy) props.onCancel();
      })}
    >
      {/* While a save runs, every control waits, so nothing typed then is lost or sent half-way. */}
      <fieldset className="product-form-fields" disabled={busy}>
        <label className="field">
          <span className="field-label">Name</span>
          <input
            type="text"
            data-focus="form-name"
            required
            maxLength={PRODUCT_NAME_MAX}
            value={draft.name}
            onChange={(event) => set({ name: event.target.value })}
          />
        </label>
        <fieldset className="field">
          <legend className="field-label">Repo URLs</legend>
          {draft.repoUrls.map((row, i) => (
            <div key={row.key} className="form-row">
              <input
                type="text"
                inputMode="url"
                autoComplete="off"
                aria-label={`Repo URL ${i + 1}`}
                data-row-focus={rowFocus.repoUrl(row.key)}
                value={row.url}
                onChange={(event) => setUrl(row.key, event.target.value)}
                onKeyDown={noSubmitOnEnter}
              />
              <button
                type="button"
                className="secondary"
                aria-label={`Remove Repo URL ${i + 1}`}
                onClick={() => {
                  focusNext.current = afterRemoving(
                    draft.repoUrls,
                    i,
                    rowFocus.repoUrl,
                    rowFocus.addRepoUrl,
                  );
                  set({ repoUrls: draft.repoUrls.filter(({ key }) => key !== row.key) });
                }}
              >
                Remove
              </button>
            </div>
          ))}
          {draft.repoUrls.length < PRODUCT_REPO_URLS_MAX && (
            <button
              type="button"
              className="secondary add-row"
              data-row-focus={rowFocus.addRepoUrl}
              onClick={() => {
                const key = rowKey();
                if (draft.repoUrls.length + 1 === PRODUCT_REPO_URLS_MAX) {
                  focusNext.current = rowFocus.repoUrl(key);
                }
                set({ repoUrls: [...draft.repoUrls, { key, url: "" }] });
              }}
            >
              Add a Repo URL
            </button>
          )}
        </fieldset>
        <fieldset className="field">
          <legend className="field-label">Frameworks</legend>
          {draft.dependencies.map((row, i) => {
            const name = nameOf(row.framework);
            // The row's own framework, then those no other row has picked, in the API's order; a framework Warden no
            // longer knows stays offered in its own row, by its id.
            const choices = [...frameworks.keys()].filter(
              (framework) => framework === row.framework || !picked.has(framework),
            );
            if (!frameworks.has(row.framework)) choices.unshift(row.framework);
            return (
              <div key={row.key} className="dependency-fields">
                <label className="field">
                  <span className="field-label">Framework</span>
                  <select
                    aria-label={`Framework, ${name}`}
                    data-row-focus={rowFocus.framework(row.key)}
                    value={row.framework}
                    onChange={(event) => setDependency(row.key, { framework: event.target.value })}
                  >
                    {choices.map((framework) => (
                      <option key={framework} value={framework}>
                        {nameOf(framework)}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  <span className="field-label">Version</span>
                  <input
                    type="text"
                    autoComplete="off"
                    aria-label={`Version, ${name}`}
                    value={row.version}
                    onChange={(event) => setDependency(row.key, { version: event.target.value })}
                  />
                </label>
                <label className="field">
                  <span className="field-label">Usage</span>
                  <select
                    aria-label={`Usage, ${name}`}
                    value={row.usage}
                    onChange={(event) =>
                      setDependency(row.key, { usage: Usage.parse(event.target.value) })
                    }
                  >
                    {Usage.options.map((usage) => (
                      <option key={usage} value={usage}>
                        {USAGE_WORDS[usage]}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="check">
                  <input
                    type="checkbox"
                    aria-label={`Internet-facing, ${name}`}
                    checked={row.internetFacing}
                    onChange={(event) =>
                      setDependency(row.key, { internetFacing: event.target.checked })
                    }
                  />
                  <span>Internet-facing</span>
                </label>
                <button
                  type="button"
                  className="secondary"
                  aria-label={`Remove ${name}`}
                  onClick={() => {
                    focusNext.current = afterRemoving(
                      draft.dependencies,
                      i,
                      rowFocus.framework,
                      rowFocus.addFramework,
                    );
                    set({ dependencies: draft.dependencies.filter(({ key }) => key !== row.key) });
                  }}
                >
                  Remove
                </button>
              </div>
            );
          })}
          {unpicked[0] !== undefined && (
            <button
              type="button"
              className="secondary add-row"
              data-row-focus={rowFocus.addFramework}
              onClick={() => {
                const key = rowKey();
                if (unpicked.length === 1) focusNext.current = rowFocus.framework(key);
                set({
                  dependencies: [
                    ...draft.dependencies,
                    {
                      key,
                      framework: unpicked[0]!,
                      version: "",
                      usage: "library",
                      internetFacing: false,
                    },
                  ],
                });
              }}
            >
              Add a framework
            </button>
          )}
        </fieldset>
        {props.refusal !== null && (
          <p className="card-line refused" role="alert">
            {props.refusal}
          </p>
        )}
        <div className="form-actions">
          <button
            type="submit"
            className="primary"
            disabled={draft.name.trim() === "" || busy}
            aria-busy={busy ? "true" : undefined}
          >
            Save
          </button>
          <button type="button" className="secondary" disabled={busy} onClick={props.onCancel}>
            Cancel
          </button>
        </div>
      </fieldset>
    </form>
  );
}
