import { useState } from "react";
import { Link, NavLink } from "react-router";
import { Activity, BookOpen, Boxes, Cable, ChartNoAxesCombined, ChevronLeft, FileClock, FlaskConical, KeyRound, LayoutDashboard, Menu, PanelLeftClose, ScrollText, Settings, ShieldCheck } from "lucide-react";
import { Dialog } from "@base-ui/react/dialog";
import toast from "react-hot-toast";
import { useI18n } from "../i18n.jsx";
import { initializeTheme, saveTheme, themes } from "./theme.js";
import { pages, settingsSections } from "./routes.js";

const icons = { overview: LayoutDashboard, channels: Cable, models: Boxes, clients: ShieldCheck, catalog: BookOpen, keys: KeyRound, usage: ChartNoAxesCombined, logs: ScrollText, health: Activity, playground: FlaskConical, diagnostics: Activity, settings: Settings, config: FileClock };

export default function AppShell({ page, runtime, dirty, changedGroups, application, entityDrafts = {}, onRefresh, onReload, children, alerts, saveDock }) {
  const { t, language, languages, setLanguage } = useI18n();
  const [theme, setTheme] = useState(initializeTheme);
  const [collapsed, setCollapsed] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const revision = runtime?.configuration?.appliedRevision || runtime?.configuration?.revision;
  const state = runtime?.persistence?.pendingDatabaseSync ? "pending"
    : ["proxy", "caddy", "persistence"].some(stage => application?.[stage]?.ok === false) ? "partial"
      : dirty ? "dirty" : ["proxy", "caddy"].every(stage => application?.[stage]?.ok === true) ? "applied" : "unknown";
  const navigation = <nav aria-label={t("nav.primary")}>
    {[...new Set(pages.map(item => item.group))].map(group => <div className="shell-nav-group" key={group}>
      <p>{t(`shell.group.${group}`)}</p>
      {pages.filter(item => item.group === group).map(item => {
        const Icon = icons[item.id];
        return <NavLink key={item.id} to={item.path} className={`shell-nav-link${page?.id === item.id ? " selected" : ""}`}
          aria-label={t(`shell.page.${item.id}`)} title={t(`shell.page.${item.id}`)} onClick={() => setMenuOpen(false)}>
          <Icon size={18} aria-hidden="true" /><span>{t(`shell.page.${item.id}`)}</span>
          {changedGroups?.has(item.id) ? <span className="dirty-dot" aria-label={t("changes.unsaved")} /> : null}
        </NavLink>;
      })}
    </div>)}
  </nav>;
  return <div className={`console-shell${collapsed ? " sidebar-collapsed" : ""}${saveDock ? " with-save-dock" : ""}`}>
    <aside className="shell-sidebar">
      <Link className="shell-brand" to="/overview"><span>AP</span><strong>AOAI Proxy</strong></Link>
      {navigation}
      <button className="ghost sidebar-collapse" aria-label={t("shell.collapse")} onClick={() => setCollapsed(value => !value)}><PanelLeftClose size={18} /><span>{t("shell.collapse")}</span></button>
    </aside>
    <header className="shell-topbar">
      <Dialog.Root open={menuOpen} onOpenChange={setMenuOpen}>
        <Dialog.Trigger className="ghost mobile-nav-trigger" aria-label={t("nav.primary")}><Menu size={20} /></Dialog.Trigger>
        <Dialog.Portal>
          <Dialog.Backdrop className="ui-backdrop" />
          <Dialog.Popup className="mobile-sidebar">
            <Dialog.Title>AOAI Proxy</Dialog.Title>
            <Dialog.Close className="ghost" aria-label={t("common.close")}><ChevronLeft size={18} /></Dialog.Close>
            {navigation}
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>
      <div className="shell-breadcrumb"><span>{t(`shell.group.${page?.group || "overview"}`)}</span><span aria-hidden="true"> / </span><strong>{t(`shell.page.${page?.id || "notFound"}`)}</strong></div>
      <span className="status-pill">{runtime?.distribution?.profile || "—"}</span>
      <details className="config-status-menu">
        <summary className={`status-pill status-${state}`}>{state === "unknown" ? t("ui.unknown") : t(`shell.state.${state}`)} {revision ? <code>{revision.slice(0, 8)}</code> : null}</summary>
        <div className="shell-menu">
          <button className="ghost" onClick={onRefresh}>{t("shell.refresh")}</button>
          <button className="ghost" onClick={onReload}>{t("hero.reloadFromStore")}</button>
          <Link to="/config/history">{t("config.history.title")}</Link>
          <Link to="/config/sync">{t("shell.sync")}</Link>
          {Object.keys(entityDrafts).length ? <div className="retained-drafts">
            <p>{t("ui.unapplied")}</p>
            {Object.keys(entityDrafts).map(key => {
              const separator = key.indexOf(":");
              const type = key.slice(0, separator);
              const id = key.slice(separator + 1);
              const path = type === "upstreams" ? "channels" : type;
              return <Link key={key} to={`/${path}?edit=${encodeURIComponent(id)}`}>{t(`shell.page.${path}`)} · {id}</Link>;
            })}
          </div> : null}
        </div>
      </details>
      <label className="shell-select"><span className="sr-only">{t("common.language")}</span><select value={language} onChange={event => setLanguage(event.target.value)}>{languages.map(code => <option key={code} value={code}>{t(`lang.${code}`)}</option>)}</select></label>
      <label className="shell-select"><span className="sr-only">{t("shell.theme")}</span><select value={theme} onChange={event => {
        try { saveTheme(event.target.value); setTheme(event.target.value); }
        catch (error) { toast.error(`${t("ui.themeStoreFailed")}: ${error.message}`); }
      }}>{themes.map(value => <option key={value} value={value}>{t(`shell.theme.${value}`)}</option>)}</select></label>
    </header>
    <main className="shell-main">
      <div className="alert-region">{alerts}</div>
      <header className="page-header"><h1>{t(`shell.page.${page?.id || "notFound"}`)}</h1><p>{t(`shell.desc.${page?.id || "notFound"}`)}</p></header>
      {page?.id === "settings" ? <nav className="section-tabs" aria-label={t("nav.details")}>{Object.keys(settingsSections).map(id => <NavLink key={id} to={`/settings/${id}`}>{t(`shell.settings.${id}`)}</NavLink>)}</nav> : null}
      {page?.id === "config" ? <nav className="section-tabs" aria-label={t("nav.details")}>{["history", "sync"].map(id => <NavLink key={id} to={`/config/${id}`}>{t(`shell.config.${id}`)}</NavLink>)}</nav> : null}
      <div className="tab-content legacy-page">{children}</div>
    </main>
    {saveDock}
  </div>;
}
