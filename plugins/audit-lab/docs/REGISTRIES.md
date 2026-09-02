# Private Registry Authentication

The audit-lab container runs scanners (dependency-checker, SonarQube,
language linters) that resolve project dependencies. When projects pull
from PRIVATE/INTERNAL package registries — Artifactory, Nexus, Google
Artifact Registry, AWS CodeArtifact, GitHub Packages, GitLab Package
Registry, private PyPI, etc. — those scanners need credentials.

The plugin reads `~/.config/audit-lab/registries.yaml` at container
start, mounts the listed files into the container read-only, and exports
any listed env vars.

## File format

```yaml
mounts:
  # Maven — settings.xml with server credentials
  - source: ~/.m2/settings.xml
    target: /root/.m2/settings.xml

  # Gradle — gradle.properties with credentials
  - source: ~/.gradle/gradle.properties
    target: /root/.gradle/gradle.properties

  # npm — .npmrc with registry tokens
  - source: ~/.npmrc
    target: /root/.npmrc

  # pip — pip.conf for private PyPI index
  - source: ~/.config/pip/pip.conf
    target: /root/.config/pip/pip.conf

  # Go — netrc for private module authentication
  - source: ~/.netrc
    target: /root/.netrc

  # NuGet (.NET) — NuGet.Config with package sources
  - source: ~/.nuget/NuGet/NuGet.Config
    target: /root/.nuget/NuGet/NuGet.Config

  # Cargo (Rust) — registry credentials
  - source: ~/.cargo/credentials.toml
    target: /root/.cargo/credentials.toml

  # Composer (PHP) — auth.json for private packages
  - source: ~/.config/composer/auth.json
    target: /root/.config/composer/auth.json

  # Google ADC (any language using Artifact Registry)
  - source: ~/.config/gcloud/application_default_credentials.json
    target: /root/.config/gcloud/application_default_credentials.json

env:
  # Extra environment variables passed to the container.
  # Useful for registries that use env-based auth or custom proxy URLs.

  # Google Artifact Registry
  - GOOGLE_APPLICATION_CREDENTIALS=/root/.config/gcloud/application_default_credentials.json
  - GOOGLE_CLOUD_PROJECT=your-project-id

  # Go private modules
  # - GOPROXY=https://proxy.company.com,direct
  # - GONOSUMCHECK=company.com/*

  # pip private index
  # - PIP_INDEX_URL=https://pypi.company.com/simple
  # - PIP_EXTRA_INDEX_URL=https://pypi2.company.com/simple

  # npm private registry
  # - NPM_CONFIG_REGISTRY=https://npm.company.com

  # AWS CodeArtifact
  # - CODEARTIFACT_AUTH_TOKEN=<token>
```

## Per-language setup

### Java (Maven)

Create `~/.m2/settings.xml` with `<servers>` for your internal Maven repos:

```xml
<settings>
  <servers>
    <server>
      <id>internal-repo</id>
      <username>your-username</username>
      <password>your-password-or-token</password>
    </server>
  </servers>
  <mirrors>
    <mirror>
      <id>internal-repo</id>
      <mirrorOf>central</mirrorOf>
      <url>https://artifactory.company.com/artifactory/maven-central/</url>
    </mirror>
  </mirrors>
</settings>
```

Add to `registries.yaml`:

```yaml
mounts:
  - source: ~/.m2/settings.xml
    target: /root/.m2/settings.xml
```

### Java (Gradle)

Create `~/.gradle/gradle.properties` with credentials:

```properties
artifactoryUser=your-username
artifactoryPassword=your-password-or-token
```

Add to `registries.yaml`:

```yaml
mounts:
  - source: ~/.gradle/gradle.properties
    target: /root/.gradle/gradle.properties
```

### JavaScript / TypeScript (npm)

Create `~/.npmrc` with an auth token for your private registry:

```ini
//npm.company.com/:_authToken=your-token
registry=https://npm.company.com
```

Or use an environment variable approach:

```yaml
mounts:
  - source: ~/.npmrc
    target: /root/.npmrc
```

Alternatively, pass the token as an env var:

```yaml
env:
  - NPM_TOKEN=your-token
  - NPM_CONFIG_REGISTRY=https://npm.company.com
```

### Python (pip)

Create `~/.config/pip/pip.conf` pointing at your internal index:

```ini
[global]
index-url = https://pypi.company.com/simple
extra-index-url = https://pypi.org/simple
```

Add to `registries.yaml`:

```yaml
mounts:
  - source: ~/.config/pip/pip.conf
    target: /root/.config/pip/pip.conf
```

Or use environment variables:

```yaml
env:
  - PIP_INDEX_URL=https://pypi.company.com/simple
  - PIP_EXTRA_INDEX_URL=https://pypi.org/simple
```

### Go (private modules)

For HTTPS git-based private modules, use `~/.netrc`:

```
machine go.company.com
  login your-username
  password your-token
```

Add to `registries.yaml`:

```yaml
mounts:
  - source: ~/.netrc
    target: /root/.netrc
```

Or use environment variables to configure the Go proxy and bypass sum checks:

```yaml
env:
  - GOPROXY=https://proxy.company.com,direct
  - GONOSUMCHECK=company.com/*
  - GONOSUMDB=company.com/*
```

### Composer (PHP)

Create `~/.config/composer/auth.json` with credentials:

```json
{
  "http-basic": {
    "repo.company.com": {
      "username": "your-username",
      "password": "your-password-or-token"
    }
  }
}
```

Add to `registries.yaml`:

```yaml
mounts:
  - source: ~/.config/composer/auth.json
    target: /root/.config/composer/auth.json
```

### NuGet (.NET)

Create or edit `~/.nuget/NuGet/NuGet.Config`:

```xml
<?xml version="1.0" encoding="utf-8"?>
<configuration>
  <packageSources>
    <add key="internal" value="https://nuget.company.com/v3/index.json" />
  </packageSources>
  <packageSourceCredentials>
    <internal>
      <add key="Username" value="your-username" />
      <add key="ClearTextPassword" value="your-password-or-token" />
    </internal>
  </packageSourceCredentials>
</configuration>
```

Add to `registries.yaml`:

```yaml
mounts:
  - source: ~/.nuget/NuGet/NuGet.Config
    target: /root/.nuget/NuGet/NuGet.Config
```

### Cargo (Rust)

Create `~/.cargo/credentials.toml` with a registry token:

```toml
[registries.company-crates]
token = "your-token"
```

Add to `registries.yaml`:

```yaml
mounts:
  - source: ~/.cargo/credentials.toml
    target: /root/.cargo/credentials.toml
```

### Google Artifact Registry (any language)

`gcloud auth application-default login` produces
`~/.config/gcloud/application_default_credentials.json`. Mount it and set
`GOOGLE_APPLICATION_CREDENTIALS`:

```yaml
mounts:
  - source: ~/.config/gcloud/application_default_credentials.json
    target: /root/.config/gcloud/application_default_credentials.json
env:
  - GOOGLE_APPLICATION_CREDENTIALS=/root/.config/gcloud/application_default_credentials.json
  - GOOGLE_CLOUD_PROJECT=your-project-id
```

Note: ADC tokens refresh via OAuth; the container has `--network host` so
the refresh endpoint is reachable. For long-lived auth use a service
account key JSON instead.

### AWS CodeArtifact

Generate a short-lived auth token on the host and pass it as an env var:

```bash
export CODEARTIFACT_AUTH_TOKEN=$(aws codeartifact get-authorization-token \
  --domain your-domain --domain-owner 123456789012 \
  --query authorizationToken --output text)
```

Add to `registries.yaml`:

```yaml
env:
  - CODEARTIFACT_AUTH_TOKEN=your-token
  - CODEARTIFACT_REPOSITORY_URL=https://your-domain-123456789012.d.codeartifact.us-east-1.amazonaws.com/
```

For Maven, also configure `~/.m2/settings.xml` to use `${env.CODEARTIFACT_AUTH_TOKEN}` as
the server password. Note that CodeArtifact tokens expire after 12 hours — re-run
`aws codeartifact get-authorization-token` before each long review session.

## Troubleshooting

- **Mount silently skipped** — source file does not exist on the host. Verify
  with `ls -la <source-path>`. The plugin only mounts files that exist at
  container start.
- **Container can't reach registry** — check `--network host` (default) or
  configure corporate proxy via `HTTP_PROXY`/`HTTPS_PROXY` env vars in
  `registries.yaml`.
- **Auth expired** — re-run host auth (`gcloud auth application-default login`,
  `aws sso login`, etc.) and restart the review container.
- **dependency-checker fails with 403** — the NVD API key may be missing or
  expired. Set `NVD_API_KEY` in your environment before running the review.

## Disabling the warning

Pass `--ignore-private-auth` to the `setup` subcommand to skip the warning
prompt entirely. Use when the project has only public dependencies:

```bash
python3 /path/to/plugins/audit-lab/scripts/review-cli.py setup /my/project --ignore-private-auth
```
