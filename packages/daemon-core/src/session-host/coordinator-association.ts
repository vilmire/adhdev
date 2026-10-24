/** A persisted mesh scalar is carried as evidence; restore verifies its authority. */
export function readCoordinatorMeshAssociation(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
