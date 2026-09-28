export async function register() {
  // The import must sit inside this check: Next inlines NEXT_RUNTIME per bundle
  // and drops the branch from the Edge build. An early return does not.
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { registerNode } = await import("./instrumentation-node");
    await registerNode();
  }
}
