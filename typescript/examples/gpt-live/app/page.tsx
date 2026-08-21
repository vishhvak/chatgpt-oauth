import LiveCall from "@/components/live-call";

export default function Page() {
  return (
    <main>
      <h1>gpt-live over ChatGPT OAuth</h1>
      <p className="subtitle">
        Full-duplex voice on a ChatGPT subscription. The mic stays open and the model decides when
        to speak. Ask it something that needs a real lookup and it delegates the work to
        gpt-5.6-sol through the same token, talking to you while that runs.
      </p>
      <LiveCall voice="cove" />
    </main>
  );
}
