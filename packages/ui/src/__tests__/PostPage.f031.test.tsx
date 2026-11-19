import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, useNavigate } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Page, Post, PostReply, User } from "../api/types";
import { WebGameProviders, WebGameRoutes } from "../WebGameApp";
import { leoUser, miaUser, page, post } from "./postFixtures";
import { kaiRef, reply, socialPost } from "./postReplyFixtures";
import { LocationProbe, makeClient } from "./postRender";

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

function GoTo() {
  const navigate = useNavigate();
  return (
    <>
      <button type="button" onClick={() => navigate("/p/p1?reply=r3")}>
        go r3
      </button>
      <button type="button" onClick={() => navigate("/p/p1?reply=r1")}>
        go r1
      </button>
    </>
  );
}

async function setup(p: Post, replies: (call: number) => PostReply[], url = "/p/p1", me: User | null = null) {
  const client = makeClient(me);
  vi.spyOn(client, "getPost").mockResolvedValue(p);
  vi.spyOn(client, "listUserPosts").mockResolvedValue(page([], 0));
  let calls = 0;
  const list = vi.spyOn(client, "listPostReplies").mockImplementation(async (): Promise<Page<PostReply>> => {
    calls++;
    const items = replies(calls);
    return { items, total: items.length, page: 1, perPage: 200 };
  });
  const lock = vi.spyOn(client, "lockPost").mockResolvedValue({ ...p, locked: true });
  render(
    <WebGameProviders config={{ apiBaseUrl: "http://api.test", routerMode: "browser" }} client={client}>
      <MemoryRouter initialEntries={[url]}>
        <WebGameRoutes />
        <LocationProbe />
        <GoTo />
      </MemoryRouter>
    </WebGameProviders>,
  );
  if (me) await waitFor(() => expect(client.me).toHaveBeenCalled());
  await act(async () => {});
  await act(async () => {});
  return { client, list, lock };
}

describe("PostPage with the thread (F031 § 0.16)", () => {
  it("renders the card (inThread, no replies link), the actions, then the thread", async () => {
    await setup(socialPost("p1", { replyCount: 2, hearts: 1 }), () => [reply("r1"), reply("r2", { author: kaiRef })]);
    const page = document.querySelector(".pf-post-page")!;
    const card = page.querySelector("article.pf-post")!;
    const actions = page.querySelector(".pf-post-page__actions")!;
    const thread = page.querySelector("section.pf-post-thread")!;
    expect(card.compareDocumentPosition(actions) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(actions.compareDocumentPosition(thread) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(card.querySelector(".pf-post__replies")).toBeNull();
    expect(within(card as HTMLElement).getByRole("img", { name: "1 heart" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Replies (2)" })).toBeTruthy();
  });

  it("?reply=r1 highlights and focuses #reply-r1", async () => {
    await setup(socialPost("p1", { replyCount: 2 }), () => [reply("r1"), reply("r2")], "/p/p1?reply=r1");
    const r1 = document.getElementById("reply-r1")!;
    expect(r1.classList.contains("pf-post-reply--highlight")).toBe(true);
    expect(document.activeElement).toBe(r1);
  });

  it("a missing id shows 'That reply is no longer available.'; the post still shows", async () => {
    await setup(socialPost("p1", { replyCount: 1 }), () => [reply("r1")], "/p/p1?reply=gone");
    expect(screen.getByText("That reply is no longer available.")).toBeTruthy();
    expect(document.querySelector("article.pf-post")).not.toBeNull();
    expect(document.getElementById("reply-r1")).not.toBeNull();
  });

  it("changing ?reply to an unloaded id reloads once, then highlights it", async () => {
    const { list } = await setup(socialPost("p1", { replyCount: 2 }), (n) => (n === 1 ? [reply("r1"), reply("r2")] : [reply("r1"), reply("r2"), reply("r3")]));
    expect(list).toHaveBeenCalledTimes(1);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "go r3" })));
    await act(async () => {});
    expect(list).toHaveBeenCalledTimes(2);
    const r3 = document.getElementById("reply-r3")!;
    expect(r3.classList.contains("pf-post-reply--highlight")).toBe(true);
    expect(document.activeElement).toBe(r3);
    // A loaded id doesn't reload.
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "go r1" })));
    expect(list).toHaveBeenCalledTimes(2);
    expect(document.getElementById("reply-r1")!.classList.contains("pf-post-reply--highlight")).toBe(true);
  });

  it("an unloaded id that is still missing after the reload doesn't reload again", async () => {
    const { list } = await setup(socialPost("p1", { replyCount: 1 }), () => [reply("r1")]);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "go r3" })));
    await act(async () => {});
    expect(list).toHaveBeenCalledTimes(2);
    expect(screen.getByText("That reply is no longer available.")).toBeTruthy();
    await act(async () => {});
    expect(list).toHaveBeenCalledTimes(2);
  });

  it("the thread updates the page's local post: turning replies off shows the notice and keeps the count", async () => {
    await setup(socialPost("p1", { replyCount: 1, canDelete: true }), () => [reply("r1")], "/p/p1", miaUser);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Turn off replies" })));
    expect(screen.getByRole("button", { name: "Turn on replies" })).toBeTruthy();
    expect(screen.getByText("Replies are turned off for this post.")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Replies (1)" })).toBeTruthy();
  });

  it("an older-server post (no fields) renders no thread", async () => {
    const { list } = await setup(post("p1"), () => [], "/p/p1", leoUser);
    expect(document.querySelector("article.pf-post")).not.toBeNull();
    expect(document.querySelector(".pf-post-thread")).toBeNull();
    expect(list).not.toHaveBeenCalled();
  });
});
