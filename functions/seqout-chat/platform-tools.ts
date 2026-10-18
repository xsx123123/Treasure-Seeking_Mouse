// The platform is the only schema and authorization authority. Credentials stay
// outside messages/tool arguments; callback destination is operator-configured.
export function platformToolAdapter(req: Request, body: Record<string, unknown>, callbackUrl: string) {
  const trusted = req.headers.get('x-cygnusx-platform-tools') === 'trusted';
  const envelope = trusted && body.platform_tools && typeof body.platform_tools === 'object'
    ? body.platform_tools as Record<string, unknown> : {};
  const token = typeof envelope.delegation === 'string' ? envelope.delegation : '';
  const catalog = Array.isArray(envelope.catalog) ? envelope.catalog : [];
  const capabilities = catalog.filter((item): item is Record<string, unknown> =>
    !!item && typeof item === 'object' &&
    ['none', 'confirmation'].includes(String(item.side_effect)) &&
    typeof item.tool_name === 'string' && item.tool_name.startsWith('bioops_') &&
    typeof item.capability_id === 'string' &&
    !item.capability_id.endsWith('.submit') && item.capability_id !== 'tasks.cancel');
  const enabled = trusted && token && callbackUrl;
  const map = new Map(enabled ? capabilities.map(c => [String(c.tool_name), c]) : []);
  return {
    tools: [...map.values()].map(c => ({ type: 'function', function: {
      name: c.tool_name, description: c.description, parameters: c.input_schema,
    } })),
    has: (name: string) => map.has(name),
    async call(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
      const capability = map.get(name);
      if (!capability) throw new Error('Platform capability unavailable');
      // URL never comes from the request, model, catalog or discovery metadata.
      const response = await fetch(callbackUrl, {
        method: 'POST', redirect: 'error', signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000),
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ capability_id: capability.capability_id,
          arguments: args, call_id: crypto.randomUUID() }),
      });
      if (!response.ok) throw new Error(`Platform tool unavailable (HTTP ${response.status}); do not replay`);
      return await response.json();
    },
  };
}
