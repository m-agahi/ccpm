FROM python:3.14-slim AS base

LABEL maintainer="local-code-review"
LABEL description="All-in-one scanner toolbox for local code reviews"

ENV DEBIAN_FRONTEND=noninteractive
ENV LANG=C.UTF-8
ENV PATH="/usr/local/go/bin:/root/go/bin:/opt/sonar-scanner/bin:/opt/spotbugs/bin:/opt/pmd/bin:/opt/terraform:${PATH}"

# Pinned tool versions (update these to rebuild with newer tools)
ENV GO_VERSION=1.26.3 \
    TRIVY_VERSION=0.70.0 \
    GITLEAKS_VERSION=8.30.1 \
    HADOLINT_VERSION=2.14.0 \
    SHELLCHECK_VERSION=v0.11.0 \
    TFLINT_VERSION=0.62.1 \
    PMD_VERSION=7.24.0 \
    SPOTBUGS_VERSION=4.9.8 \
    SONAR_VERSION=8.1.0.6389 \
    ZIZMOR_VERSION=1.25.2 \
    TERRAFORM_VERSION=1.15.3 \
    CHECKSTYLE_VERSION=13.4.2 \
    GOOGLE_JAVA_FORMAT_VERSION=1.35.0

WORKDIR /workspace

# ============================================================
# System dependencies + Node.js 24 LTS + PHP 8.4 + Ruby (single apt layer)
# ============================================================
RUN apt-get update \
    && apt-get install -y --no-install-recommends --fix-missing \
       curl wget git unzip xz-utils ca-certificates gnupg jq \
       build-essential pkg-config \
       libssl-dev \
       libgtk-3-dev libglib2.0-dev libwebkit2gtk-4.1-dev \
       maven \
       php-cli php-xml php-mbstring php-curl php-zip php-tokenizer \
       ruby ruby-dev \
    && curl -fsSL https://deb.nodesource.com/setup_24.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# ============================================================
# Eclipse Temurin JDK 21 + 24 (Adoptium)
# ============================================================
RUN wget -qO - https://packages.adoptium.net/artifactory/api/gpg/key/public | gpg --dearmor -o /usr/share/keyrings/adoptium.gpg \
    && echo "deb [signed-by=/usr/share/keyrings/adoptium.gpg] https://packages.adoptium.net/artifactory/deb $(awk -F= '/^VERSION_CODENAME/{print$2}' /etc/os-release) main" > /etc/apt/sources.list.d/adoptium.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends temurin-21-jdk temurin-24-jdk \
    && JAVA21=$(find /usr/lib/jvm -maxdepth 1 -name "temurin-21*" -type d | head -1) \
    && update-alternatives --set java "${JAVA21}/bin/java" \
    && update-alternatives --set javac "${JAVA21}/bin/javac" \
    && ln -sfn "${JAVA21}" /usr/lib/jvm/temurin-21
ENV JAVA_HOME=/usr/lib/jvm/temurin-21
ENV PATH="${JAVA_HOME}/bin:${PATH}"

# ============================================================
# Go (pinned version)
# ============================================================
RUN GOARCH=$(dpkg --print-architecture) \
    && curl -fsSL "https://go.dev/dl/go${GO_VERSION}.linux-${GOARCH}.tar.gz" | tar -C /usr/local -xz

# ============================================================
# Terraform CLI (pinned version)
# ============================================================
RUN ARCH=$(dpkg --print-architecture) \
    && mkdir -p /opt/terraform \
    && curl -fsSL "https://releases.hashicorp.com/terraform/${TERRAFORM_VERSION}/terraform_${TERRAFORM_VERSION}_linux_${ARCH}.zip" -o /tmp/terraform.zip \
    && unzip -o /tmp/terraform.zip -d /opt/terraform \
    && rm /tmp/terraform.zip

# ============================================================
# Composer (PHP package manager)
# ============================================================
RUN curl -fsSL https://getcomposer.org/installer | php -- --install-dir=/usr/local/bin --filename=composer --2

# ============================================================
# PHP static analysis tools (standalone .phar files — no composer deps needed)
# ============================================================
RUN curl -fsSL https://github.com/PHP-CS-Fixer/PHP-CS-Fixer/releases/latest/download/php-cs-fixer.phar \
      -o /usr/local/bin/php-cs-fixer && chmod +x /usr/local/bin/php-cs-fixer \
    && curl -fsSL https://github.com/phpstan/phpstan/releases/latest/download/phpstan.phar \
      -o /usr/local/bin/phpstan && chmod +x /usr/local/bin/phpstan \
    && curl -fsSL https://github.com/phpmd/phpmd/releases/latest/download/phpmd.phar \
      -o /usr/local/bin/phpmd && chmod +x /usr/local/bin/phpmd \
    && curl -fsSL https://github.com/PHPCSStandards/PHP_CodeSniffer/releases/latest/download/phpcs.phar \
      -o /usr/local/bin/phpcs && chmod +x /usr/local/bin/phpcs

# ============================================================
# Ruby tools (global via gem)
# ============================================================
RUN gem install --no-document rubocop bundler-audit

# ============================================================
# Python tools (pinned via pip)
# ============================================================
RUN pip install --no-cache-dir \
    semgrep==1.163.0 \
    checkov==3.2.529 \
    ruff==0.15.13 \
    mypy==2.1.0 \
    pip-audit==2.10.0 \
    sqlfluff==4.2.1 \
    yamllint==1.38.0 \
    hypothesis==6.152.7 \
    pytest==9.0.3 \
    pytest-cov==7.1.0

# ============================================================
# Node.js tools (global)
# ============================================================
RUN npm install -g \
    jscpd@4.2.2 \
    pyright@1.1.409 \
    eslint@10.4.0 \
    prettier@3.8.3 \
    typescript@6.0.3 \
    @anthropic-ai/claude-code

# Claude Code CLI settings (allow Bash and Read inside container)
RUN mkdir -p /root/.claude && \
    echo '{"permissions":{"allow":["Bash(*)","Read(*)"]}}' > /root/.claude/settings.json

# ============================================================
# Rust toolchain (for cargo clippy, cargo check, fuzz testing)
# ============================================================
ENV RUSTUP_HOME=/usr/local/rustup \
    CARGO_HOME=/usr/local/cargo \
    PATH="/usr/local/cargo/bin:${PATH}"
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain stable --profile minimal \
    && rustup component add rustfmt clippy \
    && rm -rf /usr/local/rustup/toolchains/stable-*/share/doc /usr/local/cargo/registry/cache

# ============================================================
# Go tools (pre-built binaries for multi-arch support)
# ============================================================
ENV GOLANGCI_LINT_VERSION=2.12.2 \
    STATICCHECK_VERSION=2026.1 \
    SHFMT_VERSION=3.13.1 \
    ACTIONLINT_VERSION=1.7.12 \
    CHECKMAKE_VERSION=0.3.2

# golangci-lint
RUN ARCH=$(dpkg --print-architecture) \
    && curl -fsSL "https://github.com/golangci/golangci-lint/releases/download/v${GOLANGCI_LINT_VERSION}/golangci-lint-${GOLANGCI_LINT_VERSION}-linux-${ARCH}.tar.gz" \
       | tar -C /usr/local/bin -xz --strip-components=1 "golangci-lint-${GOLANGCI_LINT_VERSION}-linux-${ARCH}/golangci-lint"

# staticcheck
RUN ARCH=$(dpkg --print-architecture) \
    && curl -fsSL "https://github.com/dominikh/go-tools/releases/download/${STATICCHECK_VERSION}/staticcheck_linux_${ARCH}.tar.gz" \
       | tar -C /usr/local/bin -xz --strip-components=1 "staticcheck/staticcheck"

# shfmt
RUN ARCH=$(dpkg --print-architecture) \
    && curl -fsSL "https://github.com/mvdan/sh/releases/download/v${SHFMT_VERSION}/shfmt_v${SHFMT_VERSION}_linux_${ARCH}" \
       -o /usr/local/bin/shfmt && chmod +x /usr/local/bin/shfmt

# actionlint
RUN ARCH=$(dpkg --print-architecture) \
    && curl -fsSL "https://github.com/rhysd/actionlint/releases/download/v${ACTIONLINT_VERSION}/actionlint_${ACTIONLINT_VERSION}_linux_${ARCH}.tar.gz" \
       | tar -C /usr/local/bin -xz actionlint

# checkmake (only available as go install — compile natively)
RUN go install github.com/checkmake/checkmake/cmd/checkmake@v${CHECKMAKE_VERSION} \
    && rm -rf /root/go/pkg/mod/cache

# ============================================================
# Binary downloads (all pinned versions)
# ============================================================

# Zizmor (pre-built binary)
RUN ARCH=$(dpkg --print-architecture) \
    && ZIZ_ARCH=$([ "$ARCH" = "amd64" ] && echo "x86_64-unknown-linux-gnu" || echo "aarch64-unknown-linux-gnu") \
    && curl -fsSL "https://github.com/woodruffw/zizmor/releases/download/v${ZIZMOR_VERSION}/zizmor-${ZIZ_ARCH}.tar.gz" | tar -C /usr/local/bin -xz --strip-components=0

# Trivy
RUN ARCH=$(dpkg --print-architecture) \
    && curl -fsSL "https://github.com/aquasecurity/trivy/releases/download/v${TRIVY_VERSION}/trivy_${TRIVY_VERSION}_Linux-$([ "$ARCH" = "amd64" ] && echo "64bit" || echo "ARM64").tar.gz" | tar -C /usr/local/bin -xz trivy

# Gitleaks
RUN ARCH=$(dpkg --print-architecture) \
    && GL_ARCH=$([ "$ARCH" = "amd64" ] && echo "x64" || echo "arm64") \
    && curl -fsSL "https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/gitleaks_${GITLEAKS_VERSION}_linux_${GL_ARCH}.tar.gz" | tar -C /usr/local/bin -xz gitleaks

# Hadolint
RUN ARCH=$(dpkg --print-architecture) \
    && HL_ARCH=$([ "$ARCH" = "amd64" ] && echo "x86_64" || echo "arm64") \
    && curl -fsSL -o /usr/local/bin/hadolint "https://github.com/hadolint/hadolint/releases/download/v${HADOLINT_VERSION}/hadolint-Linux-${HL_ARCH}" \
    && chmod +x /usr/local/bin/hadolint

# ShellCheck
RUN ARCH=$(dpkg --print-architecture) \
    && SC_ARCH=$([ "$ARCH" = "amd64" ] && echo "x86_64" || echo "aarch64") \
    && curl -fsSL "https://github.com/koalaman/ShellCheck/releases/download/${SHELLCHECK_VERSION}/shellcheck-${SHELLCHECK_VERSION}.linux.${SC_ARCH}.tar.xz" | tar -C /tmp -xJ \
    && mv /tmp/shellcheck-*/shellcheck /usr/local/bin/ \
    && rm -rf /tmp/shellcheck-*

# TFLint
RUN ARCH=$(dpkg --print-architecture) \
    && curl -fsSL "https://github.com/terraform-linters/tflint/releases/download/v${TFLINT_VERSION}/tflint_linux_${ARCH}.zip" -o /tmp/tflint.zip \
    && unzip -o /tmp/tflint.zip -d /usr/local/bin \
    && rm /tmp/tflint.zip

# PMD
RUN curl -fsSL "https://github.com/pmd/pmd/releases/download/pmd_releases%2F${PMD_VERSION}/pmd-dist-${PMD_VERSION}-bin.zip" -o /tmp/pmd.zip \
    && unzip -o /tmp/pmd.zip -d /opt \
    && ln -sf /opt/pmd-bin-${PMD_VERSION} /opt/pmd \
    && rm /tmp/pmd.zip

# SpotBugs
RUN curl -fsSL "https://github.com/spotbugs/spotbugs/releases/download/${SPOTBUGS_VERSION}/spotbugs-${SPOTBUGS_VERSION}.tgz" | tar -C /opt -xz \
    && ln -sf /opt/spotbugs-${SPOTBUGS_VERSION} /opt/spotbugs

# Checkstyle (Google style rules for Java)
RUN curl -fsSL "https://github.com/checkstyle/checkstyle/releases/download/checkstyle-${CHECKSTYLE_VERSION}/checkstyle-${CHECKSTYLE_VERSION}-all.jar" \
      -o /usr/local/bin/checkstyle.jar

# google-java-format (Java code formatter)
RUN curl -fsSL "https://github.com/google/google-java-format/releases/download/v${GOOGLE_JAVA_FORMAT_VERSION}/google-java-format-${GOOGLE_JAVA_FORMAT_VERSION}-all-deps.jar" \
      -o /usr/local/bin/google-java-format.jar

# OWASP Dependency-Check CLI
ENV DC_VERSION=12.1.0
RUN curl -fsSL "https://github.com/jeremylong/DependencyCheck/releases/download/v${DC_VERSION}/dependency-check-${DC_VERSION}-release.zip" -o /tmp/dc.zip \
    && unzip -o /tmp/dc.zip -d /opt \
    && ln -sf /opt/dependency-check/bin/dependency-check.sh /usr/local/bin/dependency-check \
    && rm /tmp/dc.zip

# SonarScanner CLI
RUN ARCH=$(dpkg --print-architecture) \
    && SS_ARCH=$([ "$ARCH" = "amd64" ] && echo "linux-x64" || echo "linux-aarch64") \
    && curl -fsSL "https://binaries.sonarsource.com/Distribution/sonar-scanner-cli/sonar-scanner-cli-${SONAR_VERSION}-${SS_ARCH}.zip" -o /tmp/sonar.zip \
    && unzip -o /tmp/sonar.zip -d /opt \
    && ln -sf /opt/sonar-scanner-${SONAR_VERSION}-${SS_ARCH} /opt/sonar-scanner \
    && rm /tmp/sonar.zip

# ============================================================
# Pre-bake vulnerability databases (saves 30-60s per run)
# NVD_API_KEY passed via BuildKit secret (not ARG) to avoid
# leaking the key into image layer history / metadata.
# ============================================================
RUN --mount=type=secret,id=nvd_api_key,env=NVD_API_KEY \
    trivy image --download-db-only 2>/dev/null || true \
    && trivy image --download-java-db-only 2>/dev/null || true \
    && dependency-check --updateonly ${NVD_API_KEY:+--nvdApiKey "$NVD_API_KEY"} 2>/dev/null || true \
    && mkdir -p /tmp/tflint-init && echo 'plugin "aws" { enabled = true, version = "0.47.0", source = "github.com/terraform-linters/tflint-ruleset-aws" }' > /tmp/tflint-init/.tflint.hcl \
    && tflint --init --config=/tmp/tflint-init/.tflint.hcl 2>/dev/null || true \
    && rm -rf /tmp/tflint-init

# Cache semgrep rules (dry-run against empty dir)
RUN mkdir -p /tmp/empty \
    && semgrep scan --config auto --dry-run /tmp/empty 2>/dev/null || true \
    && rm -rf /tmp/empty

# ============================================================
# Verify installations
# ============================================================
RUN echo "=== Tool Versions ===" \
    && python3 --version \
    && node --version \
    && go version \
    && java -version 2>&1 | head -1 \
    && php --version | head -1 \
    && ruby --version \
    && composer --version | head -1 \
    && rustc --version \
    && cargo --version \
    && cargo clippy --version \
    && terraform --version | head -1 \
    && trivy version \
    && semgrep --version \
    && gitleaks version \
    && hadolint --version \
    && checkov --version \
    && ruff --version \
    && mypy --version \
    && pyright --version \
    && shellcheck --version | head -2 \
    && shfmt --version \
    && golangci-lint --version \
    && staticcheck --version \
    && actionlint --version \
    && zizmor --version \
    && tflint --version \
    && jscpd --version \
    && sqlfluff version \
    && yamllint --version \
    && pip-audit --version \
    && pmd --version \
    && phpcs --version \
    && phpstan --version \
    && phpmd --version 2>&1 | head -1 \
    && php-cs-fixer --version 2>&1 | head -1 \
    && rubocop --version \
    && bundle-audit version 2>&1 || true \
    && claude --version 2>&1 | head -1 \
    && sonar-scanner --version 2>&1 | head -2 \
    && mvn --version | head -1 \
    && javac -version 2>&1 \
    && java -jar /usr/local/bin/checkstyle.jar --version \
    && java -jar /usr/local/bin/google-java-format.jar --version \
    && dependency-check.sh --version 2>&1 | head -1 || true \
    && echo "=== All tools verified ==="

# Review helper scripts (baked in — no need to copy at runtime)
# Bump version label to trigger a new image build.
LABEL version="5.0.2"
COPY scripts/ /opt/review-scripts/
ENTRYPOINT ["sleep", "infinity"]
