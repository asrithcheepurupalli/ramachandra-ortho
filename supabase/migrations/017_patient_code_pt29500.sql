-- 017_patient_code_pt29500.sql
-- Transition patient code format from ROC-#### to PT##### starting at 29500 (PT29500)

alter sequence if exists patient_code_seq restart with 29500;

create or replace function assign_patient_code() returns trigger language plpgsql as $$
begin
  if new.patient_code is null then
    new.patient_code := 'PT' || nextval('patient_code_seq')::text;
  end if;
  return new;
end $$;
