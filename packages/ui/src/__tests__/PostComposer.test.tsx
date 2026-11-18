// Kept ASCII-only apart from UI strings: other non-ASCII characters are built with String.fromCodePoint.
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, type ApiClient } from "../api/client";
import type { Game, Post } from "../api/types";
import { PostComposer, type PostComposerProps } from "../components/PostComposer";
import type { PostAttachRef } from "../posts";
import { collection, game } from "./collectionFixtures";
import { miaUser, post } from "./postFixtures";
import { currentLocation, makeClient, renderWith } from "./postRender";

afterEach(() => vi.restoreAllMocks());

const fullGame = (over: Partial<Game> = {}): Game =>
  ({ ...game("g1", "Space Dodge"), width: 640, height: 360, version: 1, entry: "index.html", playUrl: "/play/g1", myRating: null, isOwner: false, isFavorite: false, achievements: [], leaderboard: { order: "desc", format: "number", label: "" }, ...over }) as Game;

async function setup(props: Partial<PostComposerProps> = {}, url = "/u/mia/posts") {
  const client = makeClient(miaUser);
  const create = vi.spyOn(client, "createPost").mockImplementation(async (req) => post("new", { body: req.body, canDelete: true }));
  const getGame = vi.spyOn(client, "getGame").mockResolvedValue(fullGame());
  const getCollection = vi.spyOn(client, "getCollection").mockResolvedValue(collection());
  const onPosted = vi.fn<(p: Post) => void>();
  await renderWith(client, <PostComposer onPosted={onPosted} {...props} />, url, miaUser);
  const form = screen.getByRole("form", { name: "New post" });
  const input = screen.getByLabelText("Post text") as HTMLTextAreaElement;
  const submit = within(form).getByRole("button", { name: "Post" }) as HTMLButtonElement;
  const count = () => form.querySelector<HTMLElement>(".pf-post-composer__count")!;
  return { client, create, getGame, getCollection, onPosted, form, input, submit, count };
}

const type = (el: HTMLTextAreaElement, value: string) => fireEvent.change(el, { target: { value } });

describe("PostComposer (F030 section 0.11)", () => {
  it("has a labelled textarea without maxLength, a counter and the hint", async () => {
    const { input, count, form } = await setup();
    expect(input.tagName).toBe("TEXTAREA");
    expect(input.getAttribute("rows")).toBe("3");
    expect(input.hasAttribute("maxlength")).toBe(false);
    expect(input.getAttribute("placeholder")).toBe("Share an update with your followers…");
    const hint = within(form).getByText("To attach a game or collection, use “Post about this” on its page.");
    expect(hint.className).toBe("pf-field__hint");
    expect(input.getAttribute("aria-describedby")!.split(" ")).toEqual([count().id, hint.id]);
    expect(count().textContent).toBe("0 / 500");
  });

  it("counts code points, flags over-length and disables Post at 0 and over 500", async () => {
    const { input, count, submit } = await setup();
    expect(submit.disabled).toBe(true);
    type(input, "  hi  ");
    expect(count().textContent).toBe("2 / 500");
    expect(submit.disabled).toBe(false);
    type(input, String.fromCodePoint(0x1f600).repeat(500));
    expect(count().textContent).toBe("500 / 500");
    expect(count().classList.contains("is-over")).toBe(false);
    expect(submit.disabled).toBe(false);
    type(input, "x".repeat(501));
    expect(count().textContent).toBe("501 / 500 · 1 too many");
    expect(count().classList.contains("is-over")).toBe(true);
    expect(submit.disabled).toBe(true);
    type(input, "   \n  ");
    expect(count().textContent).toBe("0 / 500");
    expect(submit.disabled).toBe(true);
  });

  it("13 lines: the lines message and no request", async () => {
    const { input, form, create } = await setup();
    type(input, Array.from({ length: 13 }, (_, i) => `line ${i}`).join("\n"));
    fireEvent.submit(form);
    expect(within(form).getByRole("alert").textContent).toBe("Posts can have at most 12 lines.");
    expect(create).not.toHaveBeenCalled();
  });

  it("a tab: the characters message and no request", async () => {
    const { input, form, create } = await setup();
    type(input, "a\tb");
    fireEvent.submit(form);
    expect(within(form).getByRole("alert").textContent).toBe("Remove tabs, control characters and invisible formatting characters.");
    expect(create).not.toHaveBeenCalled();
    // Editing clears the message.
    type(input, "ab");
    expect(within(form).queryByRole("alert")).toBeNull();
  });

  it("Ctrl+Enter posts the normalised body; success clears, toasts, calls onPosted and focuses the textarea", async () => {
    const { input, create, onPosted, count } = await setup();
    type(input, "  Hello\r\nworld  ");
    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter", ctrlKey: true });
    });
    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith({ body: "Hello\nworld" });
    expect(await screen.findByText("Post published")).toBeTruthy();
    expect(onPosted).toHaveBeenCalledWith(expect.objectContaining({ id: "new", body: "Hello\nworld" }));
    expect(input.value).toBe("");
    expect(count().textContent).toBe("0 / 500");
    expect(document.activeElement).toBe(input);
  });

  it("Cmd+Enter posts too; plain Enter doesn't", async () => {
    const { input, create } = await setup();
    type(input, "hi");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(create).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter", metaKey: true });
    });
    expect(create).toHaveBeenCalledWith({ body: "hi" });
  });

  it("a server error shows its message in the Alert and keeps the text", async () => {
    const { input, form, create, onPosted } = await setup();
    create.mockRejectedValue(new ApiError("validation", "You can post at most 25 times in 24 hours", 422));
    type(input, "hi");
    await act(async () => {
      fireEvent.submit(form);
    });
    expect(within(form).getByRole("alert").textContent).toBe("You can post at most 25 times in 24 hours");
    expect(input.value).toBe("hi");
    expect(onPosted).not.toHaveBeenCalled();
  });

  it("shows a spinner and blocks double submits while busy", async () => {
    const { input, form, create, submit } = await setup();
    let resolve!: (p: Post) => void;
    create.mockImplementation(() => new Promise<Post>((r) => (resolve = r)));
    type(input, "hi");
    fireEvent.submit(form);
    fireEvent.submit(form);
    expect(create).toHaveBeenCalledTimes(1);
    expect(submit.disabled).toBe(true);
    expect(within(submit).getByRole("status")).toBeTruthy();
    await act(async () => resolve(post("new")));
  });
});

describe("PostComposer attachments (F030 section 0.12)", () => {
  const gameRef: PostAttachRef = { type: "game", id: "g1" };

  it("loads the game, shows the preview, hides the hint and focuses the textarea", async () => {
    const { getGame, form, input } = await setup({ initialAttach: gameRef }, "/u/mia/posts?attach=game:g1");
    expect(getGame).toHaveBeenCalledWith("g1");
    const card = form.querySelector<HTMLAnchorElement>("a.pf-post-attachment")!;
    expect(card.getAttribute("href")).toBe("/games/g1");
    expect(card.textContent).toContain("Space Dodge");
    expect(within(form).queryByText(/To attach a game or collection/)).toBeNull();
    expect(input.getAttribute("aria-describedby")!.split(" ")).toHaveLength(1);
    expect(document.activeElement).toBe(input);
  });

  it("posts with gameId, then clears the attachment and ?attach", async () => {
    const { input, form, create } = await setup({ initialAttach: gameRef }, "/u/mia/posts?attach=game:g1");
    type(input, "Try this");
    await act(async () => {
      fireEvent.submit(form);
    });
    expect(create).toHaveBeenCalledWith({ body: "Try this", gameId: "g1" });
    expect(form.querySelector(".pf-post-attachment")).toBeNull();
    expect(currentLocation()).toBe("/u/mia/posts");
  });

  it("a collection: posts with collectionId", async () => {
    const { input, form, create, getCollection } = await setup({ initialAttach: { type: "collection", id: "c1" } }, "/u/mia/posts?attach=collection:c1");
    expect(getCollection).toHaveBeenCalledWith("c1");
    expect(form.querySelector("a.pf-post-attachment")!.getAttribute("href")).toBe("/c/c1");
    type(input, "My comfort list");
    await act(async () => {
      fireEvent.submit(form);
    });
    expect(create).toHaveBeenCalledWith({ body: "My comfort list", collectionId: "c1" });
  });

  it("✕ Remove clears the attachment, removes ?attach and focuses the textarea", async () => {
    const { form, input } = await setup({ initialAttach: gameRef }, "/u/mia/posts?attach=game:g1&x=1");
    (document.activeElement as HTMLElement | null)?.blur();
    const remove = within(form).getByRole("button", { name: "Remove attachment" });
    expect(remove.textContent).toBe("✕ Remove");
    fireEvent.click(remove);
    expect(form.querySelector(".pf-post-attachment")).toBeNull();
    expect(within(form).getByText(/To attach a game or collection/)).toBeTruthy();
    expect(currentLocation()).toBe("/u/mia/posts?x=1");
    expect(document.activeElement).toBe(input);
  });

  const failures: [string, PostAttachRef, (c: ApiClient) => void, string][] = [
    ["an unpublished game", gameRef, (c) => void vi.spyOn(c, "getGame").mockResolvedValue(fullGame({ published: false })), "Only published games can be attached."],
    ["a 404 game", gameRef, (c) => void vi.spyOn(c, "getGame").mockRejectedValue(new ApiError("not_found", "Game not found", 404)), "That game isn't available."],
    [
      "a 404 collection",
      { type: "collection", id: "c1" },
      (c) => void vi.spyOn(c, "getCollection").mockRejectedValue(new ApiError("not_found", "Collection not found", 404)),
      "That collection isn't available.",
    ],
    [
      "a private collection",
      { type: "collection", id: "c1" },
      (c) => void vi.spyOn(c, "getCollection").mockResolvedValue(collection({ visibility: "private" })),
      "Only public collections can be attached.",
    ],
    ["another error", gameRef, (c) => void vi.spyOn(c, "getGame").mockRejectedValue(new ApiError("internal", "Server exploded", 500)), "Server exploded"],
  ];

  it.each(failures)("%s: the message in the Alert, no attachment, ?attach removed", async (_name, ref, arrange, message) => {
    const client = makeClient(miaUser);
    arrange(client);
    await renderWith(client, <PostComposer initialAttach={ref} />, `/u/mia/posts?attach=${ref.type}:${ref.id}`, miaUser);
    const form = screen.getByRole("form", { name: "New post" });
    await waitFor(() => expect(within(form).getByRole("alert").textContent).toBe(message));
    expect(form.querySelector(".pf-post-attachment")).toBeNull();
    expect(currentLocation()).toBe("/u/mia/posts");
    // The hint is back (no attachment).
    expect(within(form).getByText(/To attach a game or collection/)).toBeTruthy();
  });
});
