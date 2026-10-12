import type { Page } from "playwright-core";
import { htmlTask, type DeliveryContract } from "./design-contract.js";

/** Check linked numeric citations only; author-date and source-free pages remain compatible. */
export async function observeCitationNumbering(page: Page) {
  return page.evaluate(() => {
    const references = document.getElementById("references");
    if (!references) return [];
    const citations = [...document.querySelectorAll<HTMLAnchorElement>('a[href^="#"]')].filter(link => !references.contains(link)).flatMap(link => {
      const number = link.innerText.trim().match(/^\[(\d+)\]$/)?.[1];
      if (!number) return [];
      let id: string; try { id = decodeURIComponent(link.hash.slice(1)); } catch { return []; }
      const target = document.getElementById(id);
      return target && references.contains(target) ? [{ number: Number(number), id, target }] : [];
    });
    if (!citations.length) return [];
    const visible = (element: Element) => {
      for (let node: Element | null = element; node; node = node.parentElement) {
        const style = getComputedStyle(node);
        if (node.hasAttribute("hidden") || style.display === "none" || style.visibility !== "visible" || Number(style.opacity) === 0) return false;
      }
      return element.getClientRects().length > 0;
    };
    const entries = [...references.querySelectorAll<HTMLElement>("li")].filter(item => !item.parentElement?.closest("li"));
    const issues: string[] = [];
    const labels = new Map<Element, number>();
    const owners = new Map<number, Element>();
    for (const entry of entries) {
      let number: number | undefined;
      // Explicit text labels survive list resets and can be compared to citation labels.
      const textLabel = entry.innerText.trim().match(/^\[(\d+)\]/);
      if (textLabel && visible(entry)) {
        const walker = document.createTreeWalker(entry, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          if (!node.textContent?.trim()) continue;
          if (node.textContent.trim().startsWith("[") && node.parentElement && visible(node.parentElement)) number = Number(textLabel[1]);
          break;
        }
      }
      // Also accept ordinary ordered-list markers, provided CSS has not suppressed them.
      const style = getComputedStyle(entry);
      const marker = getComputedStyle(entry, "::marker");
      if (number === undefined && visible(entry) && entry.parentElement instanceof HTMLOListElement
        && style.display === "list-item" && ["decimal", "decimal-leading-zero"].includes(style.listStyleType)
        && marker.content === "normal" && marker.visibility === "visible" && Number(marker.opacity) !== 0 && parseFloat(marker.fontSize) > 0) {
        const list = entry.parentElement;
        const items = [...list.children].filter((item): item is HTMLLIElement => item instanceof HTMLLIElement);
        let ordinal = list.hasAttribute("start") ? list.start : list.reversed ? items.length : 1;
        for (const item of items) {
          if (item.hasAttribute("value")) ordinal = item.value;
          if (item === entry) { number = ordinal; break; }
          ordinal += list.reversed ? -1 : 1;
        }
      }
      const id = entry.id || entry.querySelector("[id]")?.id || "unnamed entry";
      if (number === undefined) issues.push(`reference #${id} has no visible numeric label; add explicit [n] text before the entry or restore visible ordered-list markers`);
      else {
        labels.set(entry, number);
        if (owners.has(number)) issues.push(`reference #${id} duplicates label [${number}] on another entry; give each source one distinct number`);
        owners.set(number, entry);
      }
    }
    for (const citation of citations) {
      const entry = citation.target.closest("li");
      const number = entry ? labels.get(entry) : undefined;
      if (number !== citation.number) issues.push(`citation [${citation.number}] → #${citation.id} does not match its visible reference label${number === undefined ? " (missing)" : ` [${number}]`}; align the citation text and target label, reusing one number per source`);
    }
    return [...new Set(issues)];
  });
}

export function presentationRequirements(contract: DeliveryContract) {
  return contract.deliverables.filter(item => (item.presentation as { required?: boolean } | undefined)?.required === true).map(item => {
    const access = (item.presentation as { access?: string }).access;
    if (!["embed", "link", "download"].includes(String(access))) throw new Error(`Deliverable ${item.id} needs presentation.access`);
    const aliases = new Set([String(item.file)]);
    for (const task of contract.tasks.filter(task => task.method === "html_generate")) for (const resource of htmlTask(task).resources) if (resource.source === item.file) aliases.add(resource.output);
    return { id: String(item.id), access: String(access), paths: [...aliases] };
  });
}
/** Use rendered accessibility, not source references or the mere existence of an artifact. */
export async function observePresentation(page: Page, contract: DeliveryContract, explore = false) {
  const requirements = presentationRequirements(contract);
  const snapshot = () => page.evaluate(requirements => {
    const elements = [...document.querySelectorAll("body *")];
    const label = (element: Element) => `${element.tagName.toLowerCase()}${element.id ? `#${element.id}` : ""}${[...element.classList].slice(0, 2).map(value => `.${value}`).join("")}`;
    const hiddenReason = (element: Element) => {
      for (let node: Element | null = element; node; node = node.parentElement) {
        const style = getComputedStyle(node);
        if (node.hasAttribute("hidden") || node.getAttribute("aria-hidden") === "true") return `${label(node)} has hidden/aria-hidden`;
        if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse") return `${label(node)} has ${style.display === "none" ? "display:none" : `visibility:${style.visibility}`}`;
        if (Number(style.opacity) === 0) return `${label(node)} has opacity:0`;
      }
      return element.getClientRects().length ? "not rendered visibly" : `${label(element)} has no rendered box`;
    };
    const visible = (element: Element) => {
      if (!element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
      const style = getComputedStyle(element);
      return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) > 0 && element.getClientRects().length > 0 && !element.closest('[hidden],[aria-hidden="true"]');
    };
    const path = (url: string) => { try { const parsed = new URL(url, document.baseURI); return parsed.origin === location.origin ? decodeURIComponent(parsed.pathname.slice(1)) : ""; } catch { return ""; } };
    const links = [...document.querySelectorAll<HTMLAnchorElement>('a[href]')].filter(visible).map(element => path(element.href));
    const references = elements.map((element, index) => ({ element, index,
      link: element.tagName === "A" ? path((element as HTMLAnchorElement).href) : null,
      paths: element.tagName === "A" ? [] : [element.getAttribute("src"), element.getAttribute("data"), ...[...getComputedStyle(element).backgroundImage.matchAll(/url\(["']?([^"')]+)["']?\)/g)].map(match => match[1])].filter((url): url is string => Boolean(url)).map(path),
    }));
    const candidates = requirements.flatMap(requirement => references.flatMap(({ element, index, link, paths }) => {
      const matches = requirement.access !== "embed"
        ? link !== null && requirement.paths.includes(link) && (requirement.access !== "download" || element.hasAttribute("download"))
        : paths.some(path => requirement.paths.includes(path));
      return matches ? [{ id: requirement.id, index, element: label(element), reason: visible(element) ? null : hiddenReason(element) }] : [];
    }));
    const satisfied = requirements.filter(requirement => requirement.access === "embed" && requirement.paths.includes(path(location.href)) || candidates.some(candidate => candidate.id === requirement.id && candidate.reason === null)).map(requirement => requirement.id);
    return { satisfied, links, candidates };
  }, requirements);
  let observation = await snapshot();
  if (!explore) return observation;
  // Inspect only unmatched references, without clicking controls or changing CSS.
  // Permanent hiding and infinite animations must not consume a timeout per item.
  const deadline = Date.now() + 3000;
  for (const candidate of observation.candidates) {
    if (observation.satisfied.includes(candidate.id) || Date.now() >= deadline) continue;
    const element = await page.locator("body *").nth(candidate.index).elementHandle();
    if (!element) continue;
    try {
      await element.evaluate(async node => {
        if (node.getClientRects().length) node.scrollIntoView({ behavior: "instant", block: "center" });
        // Allow IntersectionObserver to start its reveal before inspecting animations.
        await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      });
      await page.waitForFunction(node => {
        if (!node?.isConnected) return true;
        for (let current: Element | null = node; current; current = current.parentElement) {
          if (current.getAnimations().some(animation => {
            const end = animation.effect?.getComputedTiming().endTime;
            return typeof end === "number" && Number.isFinite(end) && (animation.pending || animation.playState === "running");
          })) return false;
        }
        return true;
      }, element, { timeout: Math.max(1, Math.min(1500, deadline - Date.now())), polling: 50 }).catch(error => {
        if (error instanceof Error && error.name === "TimeoutError") return;
        throw error;
      });
      const current = await snapshot();
      observation = { ...current, satisfied: [...new Set([...observation.satisfied, ...current.satisfied])], links: [...new Set([...observation.links, ...current.links])] };
    } finally { await element.dispose(); }
  }
  return observation;
}
