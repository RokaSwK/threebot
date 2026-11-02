/** Add theme defaults without changing a Page's content or sandbox permissions. */
export function themedWorkspacePage(html: string, dark: boolean) {
  const foreground = dark ? "#f5f5f5" : "#1c1c1c";
  const background = dark ? "#141414" : "#ffffff";
  const style = `<style id="bot-workspace-theme">:root{color-scheme:${dark ? "dark" : "light"};--background:${background};--foreground:${foreground};--primary:${foreground};--primary-foreground:${background};--border:${dark ? "#ffffff22" : "#00000022"}}html,body{background:${background}!important;color:${foreground};font-family:system-ui,sans-serif}body{margin:0 auto;padding:16px;box-sizing:border-box;max-width:760px;font-size:16px;line-height:1.5}button,input,select,textarea{font:inherit}button{border-radius:999px;padding:8px 16px}h1{font-size:28px;margin:0 0 20px}h2{font-size:24px}</style>`;
  if (/<head\b[^>]*>/i.test(html)) return html.replace(/<head\b[^>]*>/i, (head) => head + style);
  if (/<html\b[^>]*>/i.test(html)) return html.replace(/<html\b[^>]*>/i, (head) => `${head}<head>${style}</head>`);
  return `<!doctype html><html><head>${style}</head><body>${html}</body></html>`;
}
