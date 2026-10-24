import { useEffect, useState, type PointerEvent, type RefObject } from 'react';

const MIN_TOOL_WIDTH = 320;
const MIN_WORKSPACE_WIDTH = 360;
function initialWidth() { return Math.max(MIN_TOOL_WIDTH, Math.min(470, window.innerWidth * .29)); }

export function useToolPanelWidth(shell: RefObject<HTMLDivElement | null>, sidebarOpen: boolean) {
  const [preferredWidth, setPreferredWidth] = useState(initialWidth);
  const [viewportWidth, setViewportWidth] = useState(window.innerWidth);
  const [sidebarWidth, setSidebarWidth] = useState(0);
  const [dragging, setDragging] = useState(false);
  useEffect(() => {
    const measure = () => {
      setViewportWidth(window.innerWidth);
      const sidebar = shell.current?.querySelector('.sidebar');
      setSidebarWidth(window.innerWidth >= 1280 && sidebarOpen ? sidebar?.getBoundingClientRect().width ?? 0 : 0);
    };
    measure();
    const observer = new ResizeObserver(measure);
    if (shell.current) observer.observe(shell.current);
    const sidebar = shell.current?.querySelector('.sidebar');
    if (sidebar) observer.observe(sidebar);
    window.addEventListener('resize', measure);
    const stop = () => setDragging(false);
    window.addEventListener('blur', stop);
    return () => { observer.disconnect(); window.removeEventListener('resize', measure); window.removeEventListener('blur', stop); };
  }, [shell, sidebarOpen]);
  const maxWidth = Math.max(MIN_TOOL_WIDTH, viewportWidth - sidebarWidth - MIN_WORKSPACE_WIDTH);
  const width = Math.max(MIN_TOOL_WIDTH, Math.min(preferredWidth, maxWidth));
  const resize = (value: number) => setPreferredWidth(Math.max(MIN_TOOL_WIDTH, Math.min(value, maxWidth)));
  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || viewportWidth <= 900) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragging(true);
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!dragging || !event.currentTarget.hasPointerCapture(event.pointerId)) return;
    const panel = event.currentTarget.parentElement;
    if (panel) resize(event.clientX - panel.getBoundingClientRect().left);
  };
  const stop = (event: PointerEvent<HTMLDivElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    setDragging(false);
  };
  return { width, maxWidth, minWidth: MIN_TOOL_WIDTH, viewportWidth, dragging, resize, onPointerDown, onPointerMove, stop, reset: () => setPreferredWidth(initialWidth()) };
}
