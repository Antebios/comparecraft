use font_kit::source::SystemSource;

fn normalize(mut families: Vec<String>) -> Vec<String> {
    families.retain(|name| !name.trim().is_empty());
    families.sort_by_cached_key(|name| (name.to_lowercase(), name.clone()));
    families.dedup_by(|a, b| a.eq_ignore_ascii_case(b) || a.to_lowercase() == b.to_lowercase());
    families
}

pub fn list_families() -> Result<Vec<String>, String> {
    let families = SystemSource::new()
        .all_families()
        .map_err(|error| format!("Could not enumerate installed font families: {error}"))?;
    Ok(normalize(families))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sorts_and_deduplicates_families_without_changing_names() {
        let names = ["Zulu", "", "alpha", "Alpha", "  ", "A Font", "Quoted \"Font\"", "Ä", "ä"];
        assert_eq!(
            normalize(names.into_iter().map(String::from).collect()),
            ["A Font", "Alpha", "Quoted \"Font\"", "Zulu", "Ä"]
        );
    }

    #[test]
    fn system_catalog_is_readable() {
        let families = list_families().expect("Native font discovery must succeed; check the OS font service and installed fonts");
        assert!(!families.is_empty(), "No installed font families found; install system fonts before running the native smoke test");
        assert_eq!(families, normalize(families.clone()));
    }
}
