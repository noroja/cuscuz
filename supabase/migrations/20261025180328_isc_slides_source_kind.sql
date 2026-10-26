-- Diferencia os slides da transcrição oral sem alterar a estrutura dos índices existentes.
alter table public.isc_resources drop constraint if exists isc_resources_source_kind_check;
alter table public.isc_resources add constraint isc_resources_source_kind_check
  check (source_kind in ('catalog_metadata', 'transcript', 'pdf_text', 'slides'));

alter table public.isc_resource_topics drop constraint if exists isc_resource_topics_source_kind_check;
alter table public.isc_resource_topics add constraint isc_resource_topics_source_kind_check
  check (source_kind in ('catalog_title', 'catalog_path', 'transcript', 'pdf_text', 'slides'));

alter table public.isc_segments drop constraint if exists isc_segments_source_kind_check;
alter table public.isc_segments add constraint isc_segments_source_kind_check
  check (source_kind in ('catalog_metadata', 'transcript', 'pdf_text', 'slides'));
