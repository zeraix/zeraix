"use client";

/**
 * COMPONENT_REGISTRY: the app's own pieces a layout may place (`app:<key>`).
 *
 * Typed against APP_COMPONENT_KEYS in electron/skins/layoutRefs.mjs -- the list the Rust engine
 * receives as its allow list -- so a key added there without an implementation here does not
 * compile, and one implemented here but missing there is refused at install time until it is
 * listed. Each entry validates its props with zod and renders a safe default on failure, the same
 * contract as the primitives.
 *
 * These are presentational. Anything interactive the app offers stays in the app's own components;
 * a layout can arrange the greeting, it cannot add a button that does something.
 */
import type React from "react";
import { z } from "zod";
import { APP_COMPONENT_KEYS, type AppComponentKey } from "../../../../electron/skins/layoutRefs.mjs";
import { APP_VERSION } from "@/constants/App";
import { useLocaleStore } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { useSlotValues } from "./slotContext";

export type AppComponentProps = Record<string, unknown>;

export interface AppComponentDef {
  key: AppComponentKey;
  description: string;
  schema: z.ZodType<Record<string, unknown>>;
  component: React.ComponentType<AppComponentProps>;
}

const align = z.enum(["left", "center", "right"]).default("center");
const alignClass = { left: "text-left", center: "text-center", right: "text-right" } as const;

function parse<T extends z.ZodType<Record<string, unknown>>>(schema: T, props: AppComponentProps): z.infer<T> {
  const r = schema.safeParse(props);
  if (r.success) return r.data as z.infer<T>;
  if (process.env.NODE_ENV !== "production") console.warn("[layout] app component props rejected:", r.error.issues);
  return schema.parse({}) as z.infer<T>;
}

/* ------------------------------------------------------------- greeting */

const greetingSchema = z.object({ align }).strip();

/** The plain empty-chat greeting, exactly as the app draws it with no skin. */
function Greeting(props: AppComponentProps) {
  const { align: a } = parse(greetingSchema, props);
  const v = useSlotValues();
  return (
    <div className={cn("mt-16", alignClass[a])}>
      <BrandMark size={48} />
      <p className="text-sm font-medium text-ink-muted">{String(v.title ?? "")}</p>
      <p className="mt-1 text-xs text-ink-subtle">{v.hint as React.ReactNode}</p>
    </div>
  );
}

const titleSchema = z.object({ align, size: z.enum(["sm", "md", "lg", "xl"]).default("md") }).strip();
const sizeClass = { sm: "text-sm", md: "text-base", lg: "text-xl", xl: "text-2xl" } as const;

function GreetingTitle(props: AppComponentProps) {
  const { align: a, size } = parse(titleSchema, props);
  const v = useSlotValues();
  return <h2 className={cn("skin-display font-medium leading-tight text-ink", sizeClass[size], alignClass[a])}>{String(v.title ?? "")}</h2>;
}

function GreetingHint(props: AppComponentProps) {
  const { align: a } = parse(greetingSchema, props);
  const v = useSlotValues();
  return <p className={cn("text-xs text-ink-subtle", alignClass[a])}>{v.hint as React.ReactNode}</p>;
}

/* ------------------------------------------------------------ brand mark */

const brandSchema = z.object({ size: z.number().min(16).max(160).default(48) }).strip();

function BrandMark(props: AppComponentProps) {
  const { size } = parse(brandSchema, props);
  return (
    <div
      className="mx-auto mb-3 flex items-center justify-center rounded-2xl bg-gradient-to-br from-primary to-primary/70 font-bold text-primary-foreground shadow-lg shadow-primary/25"
      style={{ width: size, height: size, fontSize: Math.max(10, Math.round(size * 0.375)) }}
      aria-hidden
    >
      AI
    </div>
  );
}

/* ---------------------------------------------------------------- misc */

const versionSchema = z.object({ prefix: z.string().max(20).default("v"), align }).strip();

function AppVersion(props: AppComponentProps) {
  const { prefix, align: a } = parse(versionSchema, props);
  return <span className={cn("text-xs tabular-nums text-ink-subtle", alignClass[a])}>{`${prefix}${APP_VERSION || "dev"}`}</span>;
}

// `format`, not `style`: `style` is a forbidden prop key in a layout (it names a sink), so no
// component may take it, whatever it would have meant here.
const todaySchema = z.object({ format: z.enum(["short", "medium", "long", "full"]).default("long"), align }).strip();

function Today(props: AppComponentProps) {
  const { format, align: a } = parse(todaySchema, props);
  const locale = useLocaleStore((s) => s.locale);
  let text: string;
  try {
    text = new Intl.DateTimeFormat(locale, { dateStyle: format }).format(new Date());
  } catch {
    text = new Date().toDateString();
  }
  return <span className={cn("text-xs text-ink-muted", alignClass[a])}>{text}</span>;
}

/* ------------------------------------------------------------- registry */

export const COMPONENT_REGISTRY: Readonly<Record<AppComponentKey, AppComponentDef>> = Object.freeze({
  greeting: { key: "greeting", description: "The empty-chat greeting block: brand mark, title and hint.", schema: greetingSchema, component: Greeting },
  greetingTitle: { key: "greetingTitle", description: "The greeting title text.", schema: titleSchema, component: GreetingTitle },
  greetingHint: { key: "greetingHint", description: "The greeting hint text.", schema: greetingSchema, component: GreetingHint },
  brandMark: { key: "brandMark", description: "The app's gradient brand mark.", schema: brandSchema, component: BrandMark },
  appVersion: { key: "appVersion", description: "The running app version.", schema: versionSchema, component: AppVersion },
  today: { key: "today", description: "Today's date in the UI language.", schema: todaySchema, component: Today },
});

export const APP_COMPONENT_LIST: readonly AppComponentDef[] = APP_COMPONENT_KEYS.map((k) => COMPONENT_REGISTRY[k]);
