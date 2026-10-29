const counters = new Map<string, number>();

export function incrementRuntimeMetric(name: string, amount = 1): void {
    counters.set(name, (counters.get(name) ?? 0) + amount);
}

export function getRuntimeMetrics(): Record<string, number> {
    return Object.fromEntries([...counters.entries()].sort(([left], [right]) => left.localeCompare(right)));
}
