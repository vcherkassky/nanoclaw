# Ollama proxy dashboard

Grafana dashboard for the metrics the Ollama proxy serves at
`http://127.0.0.1:11500/metrics` (see `src/ollama-metrics.ts`).

## Local setup (macOS, Homebrew)

```bash
brew install prometheus grafana
```

Add a scrape job to `/opt/homebrew/etc/prometheus.yml`:

```yaml
  - job_name: "ollama-proxy"
    static_configs:
    - targets: ["127.0.0.1:11500"]
```

In `/opt/homebrew/etc/grafana/grafana.ini`:

```ini
[paths]
provisioning = /opt/homebrew/etc/grafana/provisioning

[server]
http_addr = 127.0.0.1

[auth.anonymous]
enabled = true
org_role = Viewer
```

`/opt/homebrew/etc/grafana/provisioning/datasources/prometheus.yaml`:

```yaml
apiVersion: 1
datasources:
  - name: Prometheus
    uid: prometheus
    type: prometheus
    access: proxy
    url: http://127.0.0.1:9090
    isDefault: true
```

`/opt/homebrew/etc/grafana/provisioning/dashboards/nanoclaw.yaml` (point
`path` at this directory):

```yaml
apiVersion: 1
providers:
  - name: nanoclaw
    folder: NanoClaw
    type: file
    options:
      path: /path/to/nanoclaw/config-examples/grafana
```

Then:

```bash
brew services start prometheus
brew services start grafana
```

Open http://localhost:3000/d/nanoclaw-ollama-proxy. Edits to the JSON here
are picked up automatically; changes made in the Grafana UI are not saved
back, so edit the file instead.
