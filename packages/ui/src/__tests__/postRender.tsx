import { act, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { expect, vi } from "vitest";
import { ApiClient, ApiError } from "../api/client";
import type { User } from "../api/types";
import { WebGameProviders } from "../WebGameApp";

export function LocationProbe() {
  const loc = useLocation();
  return (
    <p data-testid="location" data-state={JSON.stringify(loc.state ?? null)}>
      {loc.pathname + loc.search}
    </p>
  );
}

export const currentLocation = () => screen.getByTestId("location").textContent;
export const currentState = () => JSON.parse(screen.getByTestId("location").getAttribute("data-state") || "null");

/** A client with the background calls every page makes stubbed; `me` null = anonymous; anything else 404s. */
export function makeClient(me: User | null) {
  if (me) localStorage.setItem("webgame.token", "tok");
  // Un-mocked calls get a harmless 404 (no network in tests).
  const fetchMock = async () => new Response(JSON.stringify({ error: { code: "not_found", message: "nope" } }), { status: 404 });
  const client = new ApiClient({ baseUrl: "http://api.test", fetch: fetchMock as unknown as typeof fetch });
  vi.spyOn(client, "me").mockImplementation(async () => {
    if (!me) throw new ApiError("unauthorized", "no", 401);
    return me;
  });
  vi.spyOn(client, "listMyFavorites").mockResolvedValue({ items: [], total: 0, page: 1, perPage: 100 });
  vi.spyOn(client, "unreadNotificationCount").mockResolvedValue({ unread: 0, latestAt: null, pollAfterSecs: 60 });
  return client;
}

/** Renders `children` (routes or a component) inside the providers and a MemoryRouter at `url`. */
export async function renderWith(client: ApiClient, children: ReactNode, url = "/", me: User | null = null) {
  const utils = render(
    <WebGameProviders config={{ apiBaseUrl: "http://api.test", routerMode: "browser" }} client={client}>
      <MemoryRouter initialEntries={[url]}>
        {children}
        <LocationProbe />
      </MemoryRouter>
    </WebGameProviders>,
  );
  if (me) await waitFor(() => expect(client.me).toHaveBeenCalled());
  await act(async () => {});
  await act(async () => {});
  return utils;
}
