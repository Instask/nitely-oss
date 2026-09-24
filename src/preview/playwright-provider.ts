import type {
  Browser,
  BrowserContext,
  ConsoleMessage,
  Page,
  Request,
} from "playwright-core";

import type {
  PreviewDiagnosticEvent,
  PreviewHierarchyNode,
  PreviewProviderCapabilities,
  PreviewRuntimeProvider,
  PreviewRuntimeSession,
  PreviewRuntimeStartInput,
} from "./types.js";

export const playwrightChromiumCapabilities: PreviewProviderCapabilities = {
  provider: "playwright-chromium",
  actions: [
    "navigate",
    "reload",
    "screenshot",
    "diagnostics",
    "hierarchy",
    "click",
    "type",
    "scroll",
  ],
  screenshots: { viewport: true, fullPage: true, formats: ["png"] },
  diagnostics: { console: true, pageErrors: true, failedRequests: true },
  hierarchy: { dom: true, layoutBoxes: true, computedStyle: true },
};

function now(): string {
  return new Date().toISOString();
}

function consoleEvent(message: ConsoleMessage): PreviewDiagnosticEvent {
  return {
    type: "console",
    at: now(),
    level: message.type(),
    message: message.text(),
    ...(message.location().url ? { url: message.location().url } : {}),
  };
}

function failedRequestEvent(request: Request): PreviewDiagnosticEvent {
  return {
    type: "requestfailed",
    at: now(),
    message: request.failure()?.errorText ?? "request failed",
    url: request.url(),
  };
}

class PlaywrightPreviewRuntimeSession implements PreviewRuntimeSession {
  readonly provider = "playwright-chromium";
  readonly capabilities = playwrightChromiumCapabilities;
  readonly #browser: Browser;
  readonly #context: BrowserContext;
  readonly #page: Page;
  readonly #console: PreviewDiagnosticEvent[] = [];
  readonly #pageErrors: PreviewDiagnosticEvent[] = [];
  readonly #failedRequests: PreviewDiagnosticEvent[] = [];

  constructor(input: {
    browser: Browser;
    context: BrowserContext;
    page: Page;
  }) {
    this.#browser = input.browser;
    this.#context = input.context;
    this.#page = input.page;
    this.#page.on("console", (message) => {
      this.#console.push(consoleEvent(message));
    });
    this.#page.on("pageerror", (error) => {
      this.#pageErrors.push({
        type: "pageerror",
        at: now(),
        message: error instanceof Error ? error.message : String(error),
      });
    });
    this.#page.on("requestfailed", (request) => {
      this.#failedRequests.push(failedRequestEvent(request));
    });
  }

  async currentUrl(): Promise<string | undefined> {
    return this.#page.url();
  }

  async navigate(url: string): Promise<string | undefined> {
    await this.#page.goto(url, { waitUntil: "domcontentloaded", timeout: 15_000 });
    return this.#page.url();
  }

  async reload(): Promise<string | undefined> {
    await this.#page.reload({ waitUntil: "domcontentloaded", timeout: 15_000 });
    return this.#page.url();
  }

  async screenshot(input: { fullPage: boolean }): Promise<Buffer> {
    return await this.#page.screenshot({
      fullPage: input.fullPage,
      type: "png",
      scale: "css",
    });
  }

  async diagnostics(): Promise<{
    console: PreviewDiagnosticEvent[];
    pageErrors: PreviewDiagnosticEvent[];
    failedRequests: PreviewDiagnosticEvent[];
  }> {
    return {
      console: [...this.#console],
      pageErrors: [...this.#pageErrors],
      failedRequests: [...this.#failedRequests],
    };
  }

  async hierarchy(): Promise<PreviewHierarchyNode> {
    return await this.#page.evaluate(() => {
      const maxDepth = 4;
      const maxChildren = 40;
      function textFor(element: Element): string | undefined {
        const text = (element.textContent ?? "").replace(/\s+/g, " ").trim();
        return text ? text.slice(0, 160) : undefined;
      }
      function boxFor(element: Element) {
        const box = element.getBoundingClientRect();
        return {
          x: Math.round(box.x),
          y: Math.round(box.y),
          width: Math.round(box.width),
          height: Math.round(box.height),
        };
      }
      function walk(element: Element, depth: number): PreviewHierarchyNode {
        const style = window.getComputedStyle(element);
        const node: PreviewHierarchyNode = {
          tagName: element.tagName.toLowerCase(),
          ...(element.id ? { id: element.id } : {}),
          ...(element.className && typeof element.className === "string"
            ? { className: element.className }
            : {}),
          ...(element.getAttribute("role")
            ? { role: element.getAttribute("role") ?? undefined }
            : {}),
          ...(element.getAttribute("aria-label")
            ? { name: element.getAttribute("aria-label") ?? undefined }
            : {}),
          ...(textFor(element) ? { text: textFor(element) } : {}),
          box: boxFor(element),
          computedStyle: {
            display: style.display,
            position: style.position,
            visibility: style.visibility,
            color: style.color,
            backgroundColor: style.backgroundColor,
            fontSize: style.fontSize,
          },
        };
        if (depth < maxDepth) {
          const children = Array.from(element.children)
            .slice(0, maxChildren)
            .map((child) => walk(child, depth + 1));
          if (children.length > 0) node.children = children;
        }
        return node;
      }
      return walk(document.body || document.documentElement, 0);
    });
  }

  async click(selector: string): Promise<void> {
    await this.#page.locator(selector).click({ timeout: 10_000 });
  }

  async type(selector: string, text: string): Promise<void> {
    await this.#page.locator(selector).fill(text, { timeout: 10_000 });
  }

  async scroll(input: { deltaX?: number; deltaY?: number }): Promise<void> {
    await this.#page.evaluate(
      ({ deltaX, deltaY }) => window.scrollBy(deltaX ?? 0, deltaY ?? 0),
      input,
    );
  }

  async close(): Promise<void> {
    await this.#context.close().catch(() => {});
    await this.#browser.close().catch(() => {});
  }
}

export class PlaywrightChromiumPreviewProvider implements PreviewRuntimeProvider {
  readonly provider = "playwright-chromium";
  readonly capabilities = playwrightChromiumCapabilities;
  readonly #executablePath: string | undefined;

  constructor(input: { executablePath?: string } = {}) {
    this.#executablePath = input.executablePath;
  }

  async start(input: PreviewRuntimeStartInput): Promise<PreviewRuntimeSession> {
    const { chromium } = await import("playwright-core");
    const browser = await chromium.launch({
      headless: true,
      ...(this.#executablePath ? { executablePath: this.#executablePath } : {}),
    });
    const context = await browser.newContext({
      viewport: {
        width: input.viewport.width,
        height: input.viewport.height,
      },
      deviceScaleFactor: input.viewport.deviceScaleFactor ?? 1,
      isMobile: input.viewport.isMobile ?? false,
    });
    const page = await context.newPage();
    const session = new PlaywrightPreviewRuntimeSession({
      browser,
      context,
      page,
    });
    try {
      await session.navigate(input.targetUrl);
      return session;
    } catch (error) {
      await session.close();
      throw error;
    }
  }
}
