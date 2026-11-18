import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent, type Ref } from "react";
import { useSearchParams } from "react-router-dom";
import { isApiError } from "../api/client";
import type { CollectionSummary, CreatePostRequest, GameSummary, Post, PostAttachment } from "../api/types";
import { useApi } from "../context/config";
import { useToast } from "../context/toast";
import { normalizePostBody, POST_BODY_MAX, postLength, validatePostBody, type PostAttachRef } from "../posts";
import { errorMessage } from "../util";
import { Alert, Spinner } from "./common";
import { PostAttachmentCard } from "./PostAttachmentCard";

export const POST_COMPOSER_HINT = "To attach a game or collection, use “Post about this” on its page.";

type Attached = { type: "game"; game: GameSummary } | { type: "collection"; collection: CollectionSummary };

const toAttachment = (a: Attached): PostAttachment =>
  a.type === "game" ? { type: "game", game: a.game, collection: null } : { type: "collection", game: null, collection: a.collection };

export type PostComposerProps = {
  /** Called with the created post (after the field and attachment were cleared). */
  onPosted?: (post: Post) => void;
  /** F030 § 0.12: an attachment from `?attach=`; the composer loads the target itself. Null = none. */
  initialAttach?: PostAttachRef | null;
  /** The textarea (e.g. a focus target after the last post was deleted). */
  textareaRef?: Ref<HTMLTextAreaElement>;
};

function assignRef<T>(ref: Ref<T> | undefined, value: T | null) {
  if (!ref) return;
  if (typeof ref === "function") ref(value);
  else (ref as { current: T | null }).current = value;
}

/** F030 § 0.11: the "New post" form on your own Posts section. */
export function PostComposer({ onPosted, initialAttach = null, textareaRef }: PostComposerProps) {
  const api = useApi();
  const toast = useToast();
  const [, setParams] = useSearchParams();
  const uid = useId();
  const [text, setText] = useState("");
  const [attached, setAttached] = useState<Attached | null>(null);
  const [attaching, setAttaching] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  const n = postLength(text);
  const over = n > POST_BODY_MAX;
  const countId = `${uid}-count`;
  const hintId = `${uid}-hint`;
  const showHint = !attached;

  const dropAttachParam = () =>
    setParams(
      (prev) => {
        if (!prev.has("attach")) return prev;
        const next = new URLSearchParams(prev);
        next.delete("attach");
        return next;
      },
      { replace: true },
    );

  const focusInput = () => inputRef.current?.focus();

  // Load the `?attach=` target. A null value (e.g. after `?attach` was removed) keeps the current attachment.
  const attachKey = initialAttach ? `${initialAttach.type}:${initialAttach.id}` : null;
  useEffect(() => {
    if (!initialAttach) return;
    let alive = true;
    const { type, id } = initialAttach;
    setAttaching(true);
    setAttached(null);
    setError(null);
    const fail = (message: string) => {
      setAttaching(false);
      setError(message);
      dropAttachParam();
    };
    const done = (a: Attached) => {
      setAttaching(false);
      setAttached(a);
      focusInput();
      const form = formRef.current;
      if (form && typeof form.scrollIntoView === "function") form.scrollIntoView({ block: "nearest" });
    };
    const notFound = type === "game" ? "That game isn't available." : "That collection isn't available.";
    const onError = (e: unknown) => {
      if (!alive) return;
      fail(isApiError(e) && e.status === 404 ? notFound : errorMessage(e));
    };
    if (type === "game") {
      api.getGame(id).then((g) => {
        if (!alive) return;
        if (!g || typeof g.id !== "string") fail(notFound);
        else if (g.published === false) fail("Only published games can be attached.");
        else done({ type: "game", game: g });
      }, onError);
    } else {
      api.getCollection(id).then((c) => {
        if (!alive) return;
        if (!c || typeof c.id !== "string") fail(notFound);
        else if (c.visibility === "private") fail("Only public collections can be attached.");
        else done({ type: "collection", collection: c });
      }, onError);
    }
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, attachKey]);

  const submit = async () => {
    if (busy || attaching || n === 0 || over) return;
    const problem = validatePostBody(text);
    if (problem) {
      setError(problem);
      return;
    }
    setBusy(true);
    setError(null);
    const req: CreatePostRequest = { body: normalizePostBody(text) };
    if (attached?.type === "game") req.gameId = attached.game.id;
    else if (attached?.type === "collection") req.collectionId = attached.collection.id;
    try {
      const post = await api.createPost(req);
      setBusy(false);
      setText("");
      setAttached(null);
      dropAttachParam();
      onPosted?.(post);
      toast.success("Post published");
      focusInput();
    } catch (err) {
      setBusy(false);
      setError(errorMessage(err));
    }
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    void submit();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      void submit();
    }
  };

  const removeAttachment = () => {
    setAttached(null);
    dropAttachParam();
    focusInput();
  };

  return (
    <form className="pf-panel pf-post-composer" aria-label="New post" onSubmit={onSubmit} ref={formRef} noValidate>
      <label className="pf-sr-only" htmlFor={`${uid}-text`}>
        Post text
      </label>
      <textarea
        id={`${uid}-text`}
        ref={(el) => {
          inputRef.current = el;
          assignRef(textareaRef, el);
        }}
        className="pf-input pf-post-composer__input"
        rows={3}
        value={text}
        placeholder="Share an update with your followers…"
        aria-describedby={showHint ? `${countId} ${hintId}` : countId}
        onChange={(e) => {
          setText(e.target.value);
          if (error) setError(null);
        }}
        onKeyDown={onKeyDown}
      />
      {attaching && (
        <p className="pf-post-composer__attaching pf-muted pf-small" role="status">
          <Spinner size={12} label="Loading attachment" /> Loading attachment…
        </p>
      )}
      {attached && (
        <div className="pf-post-composer__attachment">
          <PostAttachmentCard attachment={toAttachment(attached)} />
          <button type="button" className="pf-btn pf-btn--ghost pf-btn--sm" aria-label="Remove attachment" onClick={removeAttachment}>
            ✕ Remove
          </button>
        </div>
      )}
      {showHint && (
        <p className="pf-field__hint" id={hintId}>
          {POST_COMPOSER_HINT}
        </p>
      )}
      {error && <Alert>{error}</Alert>}
      <div className="pf-post-composer__foot">
        <span className={`pf-post-composer__count${over ? " is-over" : ""}`} id={countId}>
          {over ? `${n} / ${POST_BODY_MAX} · ${n - POST_BODY_MAX} too many` : `${n} / ${POST_BODY_MAX}`}
        </span>
        <button type="submit" className="pf-btn pf-btn--primary" disabled={n === 0 || over || busy}>
          {busy ? <Spinner size={14} /> : null} Post
        </button>
      </div>
    </form>
  );
}
