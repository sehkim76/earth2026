export default function ButterflyPage() {
  return (
    <main className="h-screen w-full bg-black">
      <iframe
        title="butterfly2"
        src="/butterfly2/index.html"
        className="h-full w-full border-0"
        allow="camera; gyroscope; accelerometer; xr-spatial-tracking"
      />
    </main>
  );
}
