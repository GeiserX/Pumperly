import type { Metadata } from "next";
import { PrivacyContent } from "@/components/nav/legal-modal";
import { SUPPORTED_LOCALES, DEFAULT_LOCALE } from "@/lib/og-translations";
import type { Locale } from "@/lib/i18n";

interface Props {
  params: Promise<{ locale: string }>;
}

// The privacy policy as its own page, so app stores and other sites can link to it.
// The text is the same component the in-app legal modal shows.
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale: raw } = await params;
  const locale = (SUPPORTED_LOCALES.includes(raw as Locale) ? raw : DEFAULT_LOCALE) as Locale;
  return {
    title: "Privacy Policy · Pumperly",
    description: "What Pumperly and its apps collect, and what they never do.",
    alternates: { canonical: `https://pumperly.com/${locale}/privacy` },
  };
}

export default async function PrivacyPage({ params }: Props) {
  const { locale: raw } = await params;
  const locale = (SUPPORTED_LOCALES.includes(raw as Locale) ? raw : DEFAULT_LOCALE) as Locale;
  return (
    <div className="min-h-dvh bg-white text-gray-600 dark:bg-gray-950 dark:text-gray-300">
      <main className="mx-auto max-w-2xl px-5 py-10">
        <a href={`/${locale}`} className="text-sm font-semibold text-emerald-600 hover:underline dark:text-emerald-400">
          &larr; Pumperly
        </a>
        <h1 className="mt-4 mb-6 text-2xl font-bold text-gray-900 dark:text-gray-100">Privacy Policy</h1>
        <div className="max-w-none [&_h3]:mt-6 [&_h3]:mb-2 [&_h3]:text-base [&_h3]:font-semibold [&_h3]:text-gray-800 [&_h3]:dark:text-gray-200 [&_p]:mb-3 [&_p]:text-sm [&_p]:leading-relaxed [&_ul]:mb-3 [&_ul]:list-disc [&_ul]:pl-5 [&_ul]:text-sm [&_li]:mb-1.5">
          <PrivacyContent />
        </div>
        <p className="mt-8 text-xs text-gray-400">
          Last updated: October 2026 &middot; Contact:{" "}
          <a href="mailto:support@pumperly.com" className="underline">support@pumperly.com</a>
        </p>
      </main>
    </div>
  );
}
