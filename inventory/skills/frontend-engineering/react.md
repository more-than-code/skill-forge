# React Companion

Load this companion when the frontend task is React-specific.

## React-Specific Gotchas

- `useEffect` is for synchronizing with external systems, not for user actions that belong in event handlers.
- If part of an effect should read the latest props/state without becoming reactive, prefer `useEffectEvent` over wiring that logic directly into the effect body.
- `React.memo` does not help when props change identity every render, such as inline objects and functions.
- In React Compiler-enabled codebases, avoid adding `React.memo` or `useMemo` by default. Start with clear code and add manual memoization only when the compiler is unavailable or profiling shows a real need.
- Keys in lists must be stable IDs, not array indices, when items can reorder or be inserted.
- A WebSocket or subscription per component instance multiplies work; centralize long-lived connections.
- Avoid storing data that can be derived from props or state during render.

## React Patterns

### Separate events from effects
```jsx
function ChatRoom({ roomId, theme }) {
  const onConnected = useEffectEvent(() => {
    showNotification("Connected!", theme);
  });

  useEffect(() => {
    const connection = createConnection(roomId);
    connection.on("connected", () => {
      onConnected();
    });
    connection.connect();

    return () => connection.disconnect();
  }, [roomId]);
}
```

### Container + Hook split
```jsx
function usePartnerList() {
  const [partners, setPartners] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let ignore = false;

    async function loadPartners() {
      const response = await fetch("/api/partners");
      const data = await response.json();
      if (!ignore) {
        setPartners(data);
        setLoading(false);
      }
    }

    loadPartners();
    return () => {
      ignore = true;
    };
  }, []);

  return { partners, loading };
}

function PartnerList() {
  const { partners, loading } = usePartnerList();
  if (loading) return <Skeleton />;
  return <DataGrid rows={partners} />;
}
```

### Derived state over duplicated state
```jsx
const filteredItems = items.filter((item) => item.status === filter);
```

### Manual memoization only when justified
```jsx
const Chart = memo(function Chart({ points, width, height }) {
  return <svg>{/* expensive render */}</svg>;
});

// Reach for this only when props are actually stable and profiling shows
// the skipped render is worth the extra indirection.
```

### Error isolation by panel
```jsx
<PanelGroup>
  <Panel>
    <ErrorBoundary fallback={<PanelError name="Explorer" />}>
      <ExplorerPanel />
    </ErrorBoundary>
  </Panel>
  <Panel>
    <ErrorBoundary fallback={<PanelError name="Editor" />}>
      <EditorPanel />
    </ErrorBoundary>
  </Panel>
</PanelGroup>
```

## React Review Prompts

- Does this effect synchronize with an external system, or is it compensating for missing event-driven logic?
- Would `useEffectEvent` make this effect easier to reason about by separating reactive and non-reactive logic?
- Is state placed low enough to avoid re-rendering unrelated subtrees?
- Are memoization tools solving a measured problem, or adding indirection by default in a compiler-enabled app?
- Would a custom hook make the data flow easier to read than leaving the logic inline?
- Are Suspense, lazy loading, or route-level chunking used where heavy UI is not always needed?
