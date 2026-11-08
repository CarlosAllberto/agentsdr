import { PlatformConnectPrompt, RequiresPlatform } from "@/components/settings/RequiresPlatform";
import { SettingsPage } from "@/components/settings/SettingsPage";
import { WhatsappAccountsClient } from "@/components/whatsapp/WhatsappAccountsClient";
import { requirePageOrgContext } from "@/lib/auth/context";
import { channelRules } from "@/lib/channels/rules.server";
import { docsPageUrl } from "@/lib/support";
import { runInOrganization } from "@/lib/tenancy/scope";

export const dynamic = "force-dynamic";

export const metadata = { title: "WhatsApp accounts" };

async function Numbers() {
  const ctx = await requirePageOrgContext();
  const rules = await runInOrganization(ctx.organizationId, () => channelRules("whatsapp"));
  return <WhatsappAccountsClient rules={{ warmupHours: rules.warmupHours, newChatsPerDay: rules.newChatsPerDay, secondsBetweenSends: rules.secondsBetweenSends }} />;
}

export default function WhatsappAccountsPage() {
  return (
    <RequiresPlatform
      platform="zernio"
      fallback={
        <SettingsPage title="WhatsApp accounts" description="The WhatsApp numbers messaging and calling run from, linked through Zernio.">
          {/* The gate's prompt, under the page header the client component would have supplied. */}
          <PlatformConnectPrompt platform="zernio" settingsHref="/settings/whatsapp-connection" guideHref={docsPageUrl("whatsapp/accounts")} />
        </SettingsPage>
      }
    >
      <Numbers />
    </RequiresPlatform>
  );
}
