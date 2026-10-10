import type { Page } from "playwright-core";
import { htmlTask, type DeliveryContract } from "./design-contract.js";

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
export async function observePresentation(page: Page, contract: DeliveryContract) {
  return page.evaluate(requirements => {
    const visible = (element: Element) => {
      if (!element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
      const style = getComputedStyle(element);
      return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) > 0 && element.getClientRects().length > 0 && !element.closest('[hidden],[aria-hidden="true"]');
    };
    const path = (url: string) => { try { const parsed = new URL(url, document.baseURI); return parsed.origin === location.origin ? decodeURIComponent(parsed.pathname.slice(1)) : ""; } catch { return ""; } };
    const links = [...document.querySelectorAll<HTMLAnchorElement>('a[href]')].filter(visible).map(element => path(element.href));
    const satisfied = requirements.filter(requirement => requirement.access === "embed" && requirement.paths.includes(path(location.href)) || [...document.querySelectorAll("body *")].some(element => {
      if (!visible(element)) return false;
      if (requirement.access !== "embed") return element.tagName === "A" && requirement.paths.includes(path((element as HTMLAnchorElement).href)) && (requirement.access !== "download" || element.hasAttribute("download"));
      if (element.tagName === "A") return false;
      return [element.getAttribute("src"), element.getAttribute("data"), ...[...getComputedStyle(element).backgroundImage.matchAll(/url\(["']?([^"')]+)["']?\)/g)].map(match => match[1])].some(url => url && requirement.paths.includes(path(url)));
    })).map(requirement => requirement.id);
    return { satisfied, links };
  }, presentationRequirements(contract));
}
