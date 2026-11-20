-- Dummy-vurderinger for test (Kontekst = 'Test'). Kjør etter database/assessment.sql.
-- Matcher Dummydata.xlsx: RowKey = Prosjekt|År, f.eks. P-1001|2026.
-- Slett igjen: DELETE dbo.Assessment WHERE Context = N'Test';

DECLARE @Batch UNIQUEIDENTIFIER = NEWID();

INSERT INTO dbo.Assessment (Context, Key1, Key2, Category, Comment, ModifiedBy, BatchId)
SELECT N'Test', v.Key1, v.Key2, v.Category, v.Comment, N'dummydata', @Batch
FROM (VALUES
    (N'P-1001', N'2025', N'Justert', N'Justert 4 % iht. KPI'),
    (N'P-1001', N'2026', N'Justert', N'Avtalt 4,5 % fra 1.1.'),
    (N'P-1002', N'2025', N'Ikke justert', N'Kunden avslo – ny runde i høst'),
    (N'P-1002', N'2026', N'Ikke justert', NULL),
    (N'P-1003', N'2025', N'Kan ikke justeres', N'Fastpris ut 2027'),
    (N'P-1003', N'2026', N'Kan ikke justeres', N'Fastpris ut 2027'),
    (N'P-1004', N'2026', N'Justert', NULL),
    (N'P-1005', N'2026', NULL, N'Venter på svar fra innkjøp'),
    (N'P-1006', N'2025', N'Justert', NULL),
    (N'P-1006', N'2026', N'Justert', N'Indeksregulert')
) v (Key1, Key2, Category, Comment)
WHERE NOT EXISTS (SELECT 1 FROM dbo.Assessment a
                  WHERE a.Context = N'Test' AND a.Key1 = v.Key1 AND a.Key2 = v.Key2 AND a.Key3 = N'');

SELECT * FROM dbo.vw_Assessment WHERE Context = N'Test' ORDER BY RowKey;
