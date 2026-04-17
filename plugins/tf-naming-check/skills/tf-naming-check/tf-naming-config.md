---
name: tf-naming-config
description: Terraform naming convention rulebook — based on HashiCorp style guide with team-specific overrides
type: reference
---

# Terraform Naming Convention Rulebook

Based on the [HashiCorp Terraform Style Guide](https://developer.hashicorp.com/terraform/language/syntax/style)
and [Terraform Plugin Best Practices](https://developer.hashicorp.com/terraform/plugin/best-practices/naming).

Edit this file to match your team's conventions. Rules not listed here are not checked.

---

## General Rules

- All Terraform identifiers use `snake_case` (underscores as word separators)
- Lowercase only — flag any uppercase letters in identifiers (except where noted below)
- AWS region names embedded in identifiers retain their original dashes
  - `vpc_eu-central-1` is correct; `vpc_eu_central_1` is wrong (ERROR)
- Names must be descriptive — flag single-letter or obviously meaningless names (WARNING)
- Do not use `self` as a resource label — use `this` or `default` instead (WARNING)
- `this` is the preferred generic label for resources using `for_each` or `count`
- `default` is an accepted alternative to `this` where it reads more naturally
- `main` is acceptable for the top-level module call or a clearly singular resource

---

## Block Structure — resource, module, data

### Meta-argument ordering

`count`, `for_each`, `provider`, `providers`, and `source` (for modules) must appear **at the top** of the block, before any other arguments. (ERROR)

After the last meta-argument there must be exactly **one blank line** separating them from the remaining arguments. (WARNING)

Example (correct):

```hcl
resource "aws_instance" "this" {
  count = 2

  ami           = "ami-123"
  instance_type = "t3.micro"
}
```

Example (wrong — `count` not at top):

```hcl
resource "aws_instance" "this" {
  ami           = "ami-123"
  count         = 2
  instance_type = "t3.micro"
}
```

### Argument key ordering

All argument keys within a block must be sorted **alphabetically** (ERROR). This applies at every nesting level — nested blocks and inline maps are also sorted.

### Map and list value ordering

When a map literal (`{ key = value, ... }`) or list literal (`["a", "b", ...]`) is passed as a value, its keys (for maps) or elements (for lists of strings) must be sorted alphabetically (WARNING).

Example (correct):

```hcl
tags = {
  Environment = "production"
  ManagedBy   = "terraform"
  Name        = "my-resource"
}
```

Example (wrong — keys not sorted):

```hcl
tags = {
  Name        = "my-resource"
  Environment = "production"
  ManagedBy   = "terraform"
}
```

---

## Resources

- Labels must be `snake_case` and lowercase
- Do not repeat the resource type in the label
  - `aws_instance.web_server` is correct; `aws_instance.web_server_instance` is wrong (WARNING)
- Do not use camelCase or PascalCase labels (ERROR)
- Prefer `this` for `for_each`/`count` resources; avoid `self` (WARNING)

### Exempt resource types

The following resource types use a different naming convention for their `Name` tag value
(not the Terraform label — see Tag Rules below):

- `aws_subnet` — Name tag format: `<env|vpc>-<functionality>.<az>` e.g. `preprod-ec2.a`
- `aws_security_group` — Name tag format: `<env|vpc>:<functionality>` e.g. `preprod:eks`

---

## Variables

- `snake_case`, lowercase
- Boolean variables must use `enable_`, `create_`, or `is_` prefix (WARNING)
  - `enable_deletion_protection`, `create_public_subnet`, `is_private`
- Do not include a type suffix in the name (WARNING)
  - `database_password` is correct; `database_password_string` is wrong
- Count or size variables should use `_count`, `_size`, or `_limit` suffix (INFO)

---

## Outputs

- `snake_case`, lowercase
- Should describe what is exposed, not how it is obtained
- Do not prefix with `get_`, `output_`, or `return_` (WARNING)
- Common correct suffixes: `_id`, `_arn`, `_endpoint`, `_url`, `_name`, `_cidr`

---

## Locals

- `snake_case`, lowercase
- Name should reflect what the local represents, not how it is computed
- Common patterns: `common_tags`, `name_prefix`, `account_id`

---

## Modules

- `snake_case`, lowercase
- Use noun-based names — describe what the module provisions, not what it does
  - `networking`, `database`, `compute` are correct
  - `setup_networking`, `create_database` are wrong (WARNING)
- Region names in module labels retain dashes: `vpc_eu-central-1` (not `vpc_eu_central_1`)

---

## Data Sources

- `snake_case`, lowercase
- Name should describe the data being fetched
  - `current_region`, `existing_vpc`, `available_zones` are correct
  - `data`, `lookup`, `get` alone are too generic (WARNING)

---

## Tag Rules

Tag rules apply to the values inside `tags = {}` blocks, not to Terraform identifiers.

- Tag **keys**: Title case for common keys (e.g. `Name`, `Environment`, `Area`, `Group`, `Team`)
- Tag **values**: lowercase (e.g. `production`, `platform`, not `Production`, `Platform`)
- Required tags — flag resources missing any of these (WARNING):
  - `Name`
  - `Environment`
  - `ManagedBy` (value should be `"terraform"`)
- `aws_subnet` Name tag value must match `<env|vpc>-<functionality>.<az>` pattern
- `aws_security_group` Name tag value must match `<env|vpc>:<functionality>` pattern

---

## Allowed Exceptions

The following identifiers are explicitly allowed and should not be flagged:

- `this`
- `default`
- `main`
- Region names with dashes when embedded in a longer `snake_case` identifier

---

## Severity Reference

| Level   | Meaning                         | Examples                                  |
| ------- | ------------------------------- | ----------------------------------------- |
| ERROR   | Wrong format — fix before merge | camelCase label, uppercase, dashes in id  |
| WARNING | Anti-pattern — should fix       | type in name, missing tag, `self` used    |
| INFO    | Suggestion — consider fixing    | non-descriptive name, missing size suffix |
