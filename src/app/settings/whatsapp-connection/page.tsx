import { ConnectionSettingsPage } from "@/components/settings/ChannelSettingsPages";
import { RecorderExtensionCard } from "@/components/settings/RecorderExtensionCard";

export const metadata = { title: "WhatsApp integrations" };
export const dynamic = "force-dynamic";

export default function Page() {
  return (
    <ConnectionSettingsPage
      platforms={[
        { platform: "zernio", note: "Your WhatsApp Business numbers, through Meta's official API. The first message to a lead uses an approved template." },
        { platform: "r2" },
        { platform: "gologin", note: "Only needed for cloud calling numbers (Settings → WhatsApp → Calling numbers)." },
        { platform: "calcom", note: "Only needed for AI calling campaigns that book meetings: tells them when a lead books.", webhookUrl: true },
      ]}
      title="WhatsApp integrations"
      description="Zernio connects your WhatsApp Business numbers for messaging. Calls placed from AgentSDR are recorded by the Call Recorder extension and stored in your Cloudflare R2 bucket, along with contact photos. Transcription uses the model chosen in AI provider."
    >
      <RecorderExtensionCard />
    </ConnectionSettingsPage>
  );
}
